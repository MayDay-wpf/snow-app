import {
  Check,
  Copy,
  Download,
  FileUp,
  Globe,
  Power,
  RefreshCw,
  RotateCcw,
  Save,
  Server,
  Settings2,
  Smartphone,
  Trash2,
  Unplug,
  Wifi,
  X,
} from "lucide-react";
import QRCode from "qrcode";
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  RemoteControlPairingState,
  RemoteServerDeployInput,
  RemoteServerDeployProgress,
  RemoteServerDnsCheck,
  RemoteTunnelConfigInput,
  RemoteTunnelStatus,
} from "../../../preload";
import { useI18n } from "../../i18n";
import { AutoDismissNotice } from "../AutoDismissNotice";
import { ConfirmDialog } from "../common/ConfirmDialog";
import { CustomSelect, type CustomSelectOption } from "../common/CustomSelect";
import { ApiSettingsHintIcon } from "./apiSettings/ApiSettingsFieldLabel";

type RemoteControlSettingsTab = "lan" | "wan";

type RemoteWanMode = "deploy" | "import" | "manual";

export function RemoteControlSettingsPanel(): React.JSX.Element {
  const { t } = useI18n();
  const [activeTab, setActiveTab] = useState<RemoteControlSettingsTab>("lan");
  const authMethodOptions: CustomSelectOption[] = [
    {
      value: "password",
      label: t("remoteControl.authPassword", { defaultValue: "SSH 密码" }),
    },
    {
      value: "privateKey",
      label: t("remoteControl.authPrivateKey", { defaultValue: "SSH 私钥" }),
    },
  ];
  const [state, setState] = useState<RemoteControlPairingState | null>(null);
  const [selectedUrl, setSelectedUrl] = useState("");
  const [portDraft, setPortDraft] = useState("");
  const [lanTokenDraft, setLanTokenDraft] = useState("");
  const [wanTokenDraft, setWanTokenDraft] = useState("");
  const [qrDataUrl, setQrDataUrl] = useState("");
  const [wanQrDataUrl, setWanQrDataUrl] = useState("");
  const [tunnel, setTunnel] = useState<RemoteTunnelStatus | null>(null);
  const [form, setForm] = useState({
    enabled: false,
    autoConnect: true,
    publicOrigin: "",
  });
  const wanModeInitialized = useRef(false);
  const deployCancelRequested = useRef(false);
  const [busy, setBusy] = useState(false);
  const [checkingDns, setCheckingDns] = useState(false);
  const [notice, setNotice] = useState<{
    message: string;
    tone: "success" | "error" | "info" | "warning";
  } | null>(null);
  const dismissNotice = useCallback((): void => setNotice(null), []);
  const [dnsCheck, setDnsCheck] = useState<RemoteServerDnsCheck | null>(null);
  const [deployProgress, setDeployProgress] =
    useState<RemoteServerDeployProgress | null>(null);
  const [deploymentActive, setDeploymentActive] = useState(false);
  const [deployForm, setDeployForm] = useState({
    serverIp: "",
    rootDomain: "",
    sshPort: "22",
    sshUsername: "root",
    ssh2TunnelPort: "7001",
    ssh2RemotePort: "18080",
    authMethod: "password" as "password" | "privateKey",
    password: "",
    privateKeyPath: "",
    passphrase: "",
  });
  const [wanMode, setWanMode] = useState<RemoteWanMode | null>(null);
  const [confirmingRemove, setConfirmingRemove] = useState(false);

  const applyState = useCallback((next: RemoteControlPairingState): void => {
    setState(next);
    setSelectedUrl((current) =>
      next.pairingUrls.includes(current)
        ? current
        : (next.pairingUrls[0] ?? ""),
    );
  }, []);

  const applyTunnel = useCallback((next: RemoteTunnelStatus): void => {
    setTunnel(next);
  }, []);

  /** 表单收起时跟随隧道状态刷新；展开编辑时保留用户输入。 */
  const syncFormFromTunnel = useCallback((next: RemoteTunnelStatus): void => {
    setForm((current) => {
      const merged = {
        ...current,
        enabled: next.config.enabled,
        autoConnect: next.config.autoConnect,
        publicOrigin: next.config.publicOrigin,
      };
      const unchanged =
        merged.enabled === current.enabled &&
        merged.autoConnect === current.autoConnect &&
        merged.publicOrigin === current.publicOrigin;
      return unchanged ? current : merged;
    });
  }, []);

  const load = useCallback(async (): Promise<void> => {
    setBusy(true);
    setNotice(null);
    try {
      const [pairing, tunnelStatus] = await Promise.all([
        window.snow.getRemoteControlPairingState(),
        window.snow.getRemoteTunnelStatus(),
      ]);
      applyState(pairing);
      applyTunnel(tunnelStatus);
    } catch (error) {
      setNotice({
        message:
          error instanceof Error
            ? error.message
            : t("remoteControl.noticeLoadFailed", {
                defaultValue: "无法读取手机远控状态",
              }),
        tone: "error",
      });
    } finally {
      setBusy(false);
    }
  }, [applyState, applyTunnel, t]);

  useEffect(() => {
    void load();
  }, [load]);

  /** 配置端口变化（首次加载 / 保存成功）时同步输入框；轮询返回同值不打断编辑。 */
  const configuredPort = state?.configuredPort;
  useEffect(() => {
    if (configuredPort !== undefined) {
      setPortDraft(String(configuredPort));
    }
  }, [configuredPort]);

  useEffect(
    () =>
      window.snow.onRemoteControlServerDeployProgress((progress) => {
        setDeployProgress(progress);
      }),
    [],
  );

  useEffect(() => {
    const timer = window.setInterval(() => {
      void Promise.all([
        window.snow.getRemoteControlPairingState(),
        window.snow.getRemoteTunnelStatus(),
      ]).then(([pairing, tunnelStatus]) => {
        applyState(pairing);
        applyTunnel(tunnelStatus);
      });
    }, 2_000);
    return () => window.clearInterval(timer);
  }, [applyState, applyTunnel]);

  useEffect(() => {
    if (!tunnel || wanMode === "manual") return;
    syncFormFromTunnel(tunnel);
  }, [tunnel, wanMode, syncFormFromTunnel]);

  /** 首次拿到状态后决定功能区默认项：未配置直接展开部署向导，已配置保持收起。 */
  useEffect(() => {
    if (!tunnel || wanModeInitialized.current) return;
    wanModeInitialized.current = true;
    if (!tunnel.config.configured) setWanMode("deploy");
  }, [tunnel]);

  useEffect(() => {
    let cancelled = false;
    if (!selectedUrl) {
      setQrDataUrl("");
      return;
    }
    void QRCode.toDataURL(selectedUrl, {
      width: 520,
      margin: 2,
      errorCorrectionLevel: "M",
      color: { dark: "#111318", light: "#ffffff" },
    }).then((value) => {
      if (!cancelled) setQrDataUrl(value);
    });
    return () => {
      cancelled = true;
    };
  }, [selectedUrl]);

  useEffect(() => {
    let cancelled = false;
    const url = state?.wan.pairingUrl ?? "";
    if (!url) {
      setWanQrDataUrl("");
      return;
    }
    void QRCode.toDataURL(url, {
      width: 520,
      margin: 2,
      errorCorrectionLevel: "M",
      color: { dark: "#111318", light: "#ffffff" },
    }).then((value) => {
      if (!cancelled) setWanQrDataUrl(value);
    });
    return () => {
      cancelled = true;
    };
  }, [state?.wan.pairingUrl]);

  const copy = async (): Promise<void> => {
    if (!selectedUrl) return;
    try {
      await window.snow.writeClipboardText(selectedUrl);
      setNotice({
        message: t("remoteControl.noticeCopied", {
          defaultValue: "配对地址已复制",
        }),
        tone: "success",
      });
    } catch (error) {
      setNotice({
        message:
          error instanceof Error
            ? error.message
            : t("remoteControl.noticeCopyFailed", { defaultValue: "复制失败" }),
        tone: "error",
      });
    }
  };

  const toggleEnabled = async (next: boolean): Promise<void> => {
    setBusy(true);
    setNotice(null);
    try {
      applyState(await window.snow.setRemoteControlEnabled(next));
      applyTunnel(await window.snow.getRemoteTunnelStatus());
      setNotice({
        message: next
          ? t("remoteControl.noticeEnabled", { defaultValue: "手机远控已开启" })
          : t("remoteControl.noticeDisabled", {
              defaultValue: "手机远控已关闭",
            }),
        tone: next ? "success" : "info",
      });
    } catch (error) {
      setNotice({
        message:
          error instanceof Error
            ? error.message
            : t("remoteControl.noticeToggleFailed", {
                defaultValue: "切换手机远控失败",
              }),
        tone: "error",
      });
      applyState(await window.snow.getRemoteControlPairingState());
      applyTunnel(await window.snow.getRemoteTunnelStatus());
    } finally {
      setBusy(false);
    }
  };

  const savePort = async (): Promise<void> => {
    const port = Number(portDraft.trim());
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      setNotice({
        message: t("remoteControl.errorInvalidPort", {
          defaultValue: "端口必须是 1 到 65535 的整数",
        }),
        tone: "error",
      });
      return;
    }
    setBusy(true);
    setNotice(null);
    try {
      const wasRunning = state?.running ?? false;
      applyState(await window.snow.setRemoteControlPort(port));
      setNotice({
        message: wasRunning
          ? t("remoteControl.noticePortSavedRunning", {
              values: { port },
              defaultValue:
                "端口已保存为 {{port}}，服务已按新端口重启；已配对手机需要重新扫码",
            })
          : t("remoteControl.noticePortSavedIdle", {
              values: { port },
              defaultValue: "端口已保存为 {{port}}，开启远控后生效",
            }),
        tone: "success",
      });
    } catch (error) {
      setNotice({
        message:
          error instanceof Error
            ? error.message
            : t("remoteControl.noticePortFailed", {
                defaultValue: "端口设置失败",
              }),
        tone: "error",
      });
      applyState(await window.snow.getRemoteControlPairingState());
    } finally {
      setBusy(false);
    }
  };

  const maskedSecret = (value: string): string =>
    value ? `${value.slice(0, 4)}••••${value.slice(-4)}` : "";

  const generateToken = (): string => {
    const bytes = new Uint8Array(24);
    crypto.getRandomValues(bytes);
    return btoa(String.fromCharCode(...bytes))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  };

  const copyToken = async (value: string): Promise<void> => {
    if (!value) return;
    try {
      await window.snow.writeClipboardText(value);
      setNotice({
        message: t("remoteControl.noticeTokenCopied", {
          defaultValue: "令牌已复制，可在手机上手动填写",
        }),
        tone: "success",
      });
    } catch (error) {
      setNotice({
        message:
          error instanceof Error
            ? error.message
            : t("remoteControl.noticeCopyFailed", { defaultValue: "复制失败" }),
        tone: "error",
      });
    }
  };

  const copyHostKeyFingerprint = async (value: string): Promise<void> => {
    if (!value) return;
    try {
      await window.snow.writeClipboardText(value);
      setNotice({
        message: t("remoteControl.noticeFingerprintCopied", {
          defaultValue: "主机密钥指纹已复制",
        }),
        tone: "success",
      });
    } catch (error) {
      setNotice({
        message:
          error instanceof Error
            ? error.message
            : t("remoteControl.noticeCopyFailed", { defaultValue: "复制失败" }),
        tone: "error",
      });
    }
  };

  const saveFixedToken = async (
    kind: "lan" | "wan",
    token: string | null,
  ): Promise<void> => {
    const next = token?.trim() ?? "";
    if (next && next.length < 24) {
      setNotice({
        message: t("remoteControl.noticeTokenTooShort", {
          defaultValue: "令牌至少需要 24 个字符",
        }),
        tone: "error",
      });
      return;
    }
    setBusy(true);
    setNotice(null);
    try {
      applyState(
        await window.snow.setRemoteControlFixedToken(kind, next || null),
      );
      if (kind === "lan") {
        setLanTokenDraft("");
      } else {
        setWanTokenDraft("");
      }
      setNotice({
        message: next
          ? t("remoteControl.noticeTokenPinned", {
              defaultValue:
                "令牌已固定；已配对的手机需要重新填写该令牌才能连接",
            })
          : t("remoteControl.noticeTokenUnpinned", {
              defaultValue: "已取消固定，下次启动或连接时回到自动令牌",
            }),
        tone: "success",
      });
    } catch (error) {
      setNotice({
        message:
          error instanceof Error
            ? error.message
            : t("remoteControl.noticeTokenFailed", {
                defaultValue: "保存令牌失败",
              }),
        tone: "error",
      });
      applyState(await window.snow.getRemoteControlPairingState());
    } finally {
      setBusy(false);
    }
  };

  const normalizedRootDomain = deployForm.rootDomain
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\.$/, "");

  const checkDns = async (): Promise<void> => {
    setBusy(true);
    setCheckingDns(true);
    setNotice(null);
    try {
      const result = await window.snow.checkRemoteServerDns({
        serverIp: deployForm.serverIp,
        rootDomain: deployForm.rootDomain,
      });
      setDnsCheck(result);
      setNotice({
        message: result.ready
          ? t("remoteControl.noticeDnsReady", {
              defaultValue: "snow 解析已生效，可以开始自动部署",
            })
          : t("remoteControl.noticeDnsPending", {
              defaultValue:
                "DNS 尚未生效，请核对下方的 snow A 记录后稍等几分钟再检测",
            }),
        tone: result.ready ? "success" : "warning",
      });
    } catch (error) {
      setNotice({
        message:
          error instanceof Error
            ? error.message
            : t("remoteControl.noticeDnsFailed", {
                defaultValue: "DNS 检测失败",
              }),
        tone: "error",
      });
    } finally {
      setBusy(false);
      setCheckingDns(false);
    }
  };

  const selectPrivateKey = async (): Promise<void> => {
    const path = await window.snow.sshSelectPrivateKey(
      t("remoteControl.privateKeyDialogTitle", {
        defaultValue: "选择服务器 SSH 私钥",
      }),
    );
    if (path) {
      setDeployForm((current) => ({ ...current, privateKeyPath: path }));
    }
  };

  const deployServer = async (): Promise<void> => {
    setBusy(true);
    setDeploymentActive(true);
    setNotice(null);
    deployCancelRequested.current = false;
    setDeployProgress({
      stage: "checking_dns",
      message: t("remoteControl.deployStarting", {
        defaultValue: "正在开始部署",
      }),
    });
    try {
      const input: RemoteServerDeployInput = {
        serverIp: deployForm.serverIp,
        rootDomain: deployForm.rootDomain,
        sshPort: Number(deployForm.sshPort),
        sshUsername: deployForm.sshUsername,
        authMethod: deployForm.authMethod,
        ssh2TunnelPort: Number(deployForm.ssh2TunnelPort),
        ssh2RemotePort: Number(deployForm.ssh2RemotePort),
        ...(deployForm.authMethod === "password"
          ? { password: deployForm.password }
          : {
              privateKeyPath: deployForm.privateKeyPath,
              ...(deployForm.passphrase
                ? { passphrase: deployForm.passphrase }
                : {}),
            }),
      };
      const result = await window.snow.deployRemoteControlServer(input);
      setDnsCheck(result.dns);
      setWanMode(null);
      setConfirmingRemove(false);
      applyTunnel(result.tunnel);
      applyState(await window.snow.getRemoteControlPairingState());
      setNotice({
        message: t("remoteControl.noticeDeploySuccess", {
          defaultValue:
            "部署成功。请关闭手机 Wi-Fi，用蜂窝网络扫描下方公网二维码验收",
        }),
        tone: "success",
      });
    } catch (error) {
      setDeployProgress(null);
      if (deployCancelRequested.current) {
        setNotice({
          message: t("remoteControl.noticeDeployCanceled", {
            defaultValue: "部署已取消",
          }),
          tone: "info",
        });
      } else {
        setNotice({
          message:
            error instanceof Error
              ? error.message
              : t("remoteControl.noticeDeployFailed", {
                  defaultValue: "服务器自动部署失败",
                }),
          tone: "error",
        });
      }
      applyTunnel(await window.snow.getRemoteTunnelStatus());
    } finally {
      deployCancelRequested.current = false;
      setDeployForm((current) => ({
        ...current,
        password: "",
        passphrase: "",
      }));
      setDeploymentActive(false);
      setBusy(false);
    }
  };

  const cancelDeployment = async (): Promise<void> => {
    if (await window.snow.cancelRemoteControlServerDeployment()) {
      deployCancelRequested.current = true;
      setNotice({
        message: t("remoteControl.noticeCancelingDeploy", {
          defaultValue:
            "正在取消部署；服务器上的当前安装命令可能需要片刻才能停止",
        }),
        tone: "info",
      });
    }
  };

  const saveAndConnect = async (): Promise<void> => {
    setBusy(true);
    setNotice(null);
    try {
      const ssh2Config = tunnel?.config.ssh2;
      if (!tunnel?.config.configured || !ssh2Config?.configured) {
        throw new Error(
          "本机还没有 SSH2 隧道配置；请先在“部署新服务器”中自动部署并授权此设备",
        );
      }
      if (!ssh2Config.hasPrivateKey) {
        throw new Error(
          "本机缺少 SSH2 隧道私钥，请使用“自动部署并连接”重新授权此设备",
        );
      }
      // 沿用已存私钥（不传 privateKey），元数据取自保存的配置。
      const input: RemoteTunnelConfigInput = {
        enabled: form.enabled,
        autoConnect: form.autoConnect,
        publicOrigin: form.publicOrigin,
        ssh2: {
          serverAddr: ssh2Config.serverAddr,
          serverPort: ssh2Config.serverPort,
          username: ssh2Config.username,
          remotePort: ssh2Config.remotePort,
          hostKeyType: ssh2Config.hostKeyType,
          hostKeyPublicKey: ssh2Config.hostKeyPublicKey,
          hostKeyFingerprint: ssh2Config.hostKeyFingerprint,
        },
      };
      let next = await window.snow.saveRemoteTunnelConfig(input);
      if (input.enabled) {
        next = await window.snow.connectRemoteTunnel();
      } else {
        next = await window.snow.disconnectRemoteTunnel();
      }
      setWanMode(null);
      setConfirmingRemove(false);
      applyTunnel(next);
      applyState(await window.snow.getRemoteControlPairingState());
      setNotice({
        message: input.enabled
          ? t("remoteControl.noticeTunnelSaved", {
              defaultValue: "配置已加密保存，正在验证公网入口",
            })
          : t("remoteControl.noticeTunnelDisabled", {
              defaultValue: "公网远控已关闭，局域网远控保持可用",
            }),
        tone: input.enabled ? "info" : "success",
      });
    } catch (error) {
      setNotice({
        message:
          error instanceof Error
            ? error.message
            : t("remoteControl.noticeTunnelSaveFailed", {
                defaultValue: "保存或连接失败",
              }),
        tone: "error",
      });
      applyTunnel(await window.snow.getRemoteTunnelStatus());
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async (): Promise<void> => {
    setBusy(true);
    setNotice(null);
    try {
      applyTunnel(await window.snow.disconnectRemoteTunnel());
      applyState(await window.snow.getRemoteControlPairingState());
      setNotice({
        message: t("remoteControl.noticeTunnelDisconnected", {
          defaultValue: "公网隧道已断开，局域网远控保持可用",
        }),
        tone: "success",
      });
    } catch (error) {
      setNotice({
        message:
          error instanceof Error
            ? error.message
            : t("remoteControl.noticeDisconnectFailed", {
                defaultValue: "断开失败",
              }),
        tone: "error",
      });
    } finally {
      setBusy(false);
    }
  };

  const connectTunnel = async (): Promise<void> => {
    setBusy(true);
    setNotice(null);
    try {
      applyTunnel(await window.snow.connectRemoteTunnel());
      applyState(await window.snow.getRemoteControlPairingState());
      setNotice({
        message: t("remoteControl.noticeTunnelConnecting", {
          defaultValue: "正在连接公网隧道，HTTPS 探测结果会自动刷新",
        }),
        tone: "info",
      });
    } catch (error) {
      setNotice({
        message:
          error instanceof Error
            ? error.message
            : t("remoteControl.noticeConnectFailed", {
                defaultValue: "连接公网失败",
              }),
        tone: "error",
      });
      applyTunnel(await window.snow.getRemoteTunnelStatus());
    } finally {
      setBusy(false);
    }
  };

  /** 移除本机公网配置：断开隧道并删除加密保存的隧道私钥。 */
  const removeConfig = async (): Promise<void> => {
    setBusy(true);
    setNotice(null);
    try {
      applyTunnel(await window.snow.removeRemoteTunnelConfig());
      applyState(await window.snow.getRemoteControlPairingState());
      setConfirmingRemove(false);
      setWanMode(null);
      setNotice({
        message: t("remoteControl.noticeConfigRemoved", {
          defaultValue: "公网配置已移除，服务器上的隧道服务与 Caddy 不受影响",
        }),
        tone: "success",
      });
    } catch (error) {
      setNotice({
        message:
          error instanceof Error
            ? error.message
            : t("remoteControl.noticeRemoveFailed", {
                defaultValue: "移除公网配置失败",
              }),
        tone: "error",
      });
      applyTunnel(await window.snow.getRemoteTunnelStatus());
    } finally {
      setBusy(false);
    }
  };

  /** 导出本机公网配置为配置包（SSH2 私钥不会写入文件），可迁移到其他设备导入。 */
  const exportConfig = async (): Promise<void> => {
    setBusy(true);
    setNotice(null);
    try {
      const result = await window.snow.exportRemoteTunnelConfig();
      if (result.canceled) return;
      setNotice({
        message: t("remoteControl.noticeExported", {
          values: { path: result.path ?? "" },
          defaultValue:
            "配置包已导出到 {{path}}；SSH2 配置不含私钥，可安全传递",
        }),
        tone: "success",
      });
    } catch (error) {
      setNotice({
        message:
          error instanceof Error
            ? error.message
            : t("remoteControl.noticeExportFailed", {
                defaultValue: "导出配置包失败",
              }),
        tone: "error",
      });
    } finally {
      setBusy(false);
    }
  };

  /** 未配置时展开表单默认按“启用并自动连接”填写，已配置时沿用已存值。 */
  const openManualForm = (): void => {
    if (tunnel && !tunnel.config.configured) {
      setForm((current) => ({ ...current, enabled: true, autoConnect: true }));
    }
    setConfirmingRemove(false);
    setWanMode("manual");
  };

  const closeManualForm = (): void => {
    setWanMode(null);
    if (tunnel) syncFormFromTunnel(tunnel);
  };

  const toggleWanMode = (mode: RemoteWanMode): void => {
    setWanMode((current) => (current === mode ? null : mode));
  };

  const toggleManualForm = (): void => {
    if (wanMode === "manual") {
      closeManualForm();
      return;
    }
    openManualForm();
  };

  const importConfig = async (): Promise<void> => {
    setBusy(true);
    setNotice(null);
    try {
      const result = await window.snow.importRemoteTunnelConfig();
      if (result.canceled || !result.status) return;
      setWanMode(null);
      setConfirmingRemove(false);
      applyTunnel(result.status);
      applyState(await window.snow.getRemoteControlPairingState());
      setNotice({
        message: result.status.config.ssh2.needsAuthorization
          ? t("remoteControl.ssh2NeedsAuthorization", {
              defaultValue:
                "SSH2 配置已导入，但本机缺少隧道私钥；请使用“自动部署并连接”重新授权此设备。",
            })
          : t("remoteControl.noticeImported", {
              defaultValue:
                "配置包已校验并加密保存，Snow 正在连接。SSH2 配置不含私钥，可安全传递。",
            }),
        tone: result.status.config.ssh2.needsAuthorization
          ? "warning"
          : "success",
      });
    } catch (error) {
      setNotice({
        message:
          error instanceof Error
            ? error.message
            : t("remoteControl.noticeImportFailed", {
                defaultValue: "导入配置包失败",
              }),
        tone: "error",
      });
    } finally {
      setBusy(false);
    }
  };

  const tunnelStageLabel: Record<RemoteTunnelStatus["stage"], string> = {
    stopped: t("remoteControl.tunnelStageStopped", { defaultValue: "已关闭" }),
    starting: t("remoteControl.tunnelStageStarting", {
      defaultValue: "正在启动本机入口",
    }),
    connecting: t("remoteControl.tunnelStageConnecting", {
      defaultValue: "隧道已启动，正在检查 HTTPS",
    }),
    online: t("remoteControl.tunnelStageOnline", {
      defaultValue: "公网入口可用",
    }),
    reconnecting: t("remoteControl.tunnelStageReconnecting", {
      defaultValue: "网络中断，正在重连",
    }),
    failed: t("remoteControl.tunnelStageFailed", { defaultValue: "连接失败" }),
  };

  const endpointStageLabel: Record<
    RemoteTunnelStatus["endpoint"]["stage"],
    string
  > = {
    unchecked: t("remoteControl.endpointUnchecked", { defaultValue: "未检查" }),
    checking: t("remoteControl.endpointChecking", { defaultValue: "正在检查" }),
    reachable: t("remoteControl.endpointReachable", { defaultValue: "已通过" }),
    failed: t("remoteControl.endpointFailed", { defaultValue: "未通过" }),
  };

  return (
    <div
      className="api-settings-page remote-control-settings-page"
      role="region"
    >
      <div className="remote-master-toggle">
        <div>
          <strong>
            {t("remoteControl.enableTitle", { defaultValue: "启用手机远控" })}
            <ApiSettingsHintIcon
              hint={t("remoteControl.enableDescription", {
                defaultValue:
                  "关闭时不会监听端口或连接隧道；开启状态在重启后保持。",
              })}
            />
          </strong>
        </div>
        <label className="toggle-switch">
          <input
            type="checkbox"
            checked={state?.enabled ?? false}
            disabled={busy || !state}
            onChange={(event) => void toggleEnabled(event.target.checked)}
            hidden
          />
          <span className="toggle-slider" aria-hidden="true" />
        </label>
      </div>

      <div className="import-settings-tabs remote-settings-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === "lan"}
          className={`import-settings-tab ${activeTab === "lan" ? "active" : ""}`}
          onClick={() => setActiveTab("lan")}
        >
          <Wifi size={13} strokeWidth={1.8} />
          {t("remoteControl.tabLan", { defaultValue: "局域网" })}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === "wan"}
          className={`import-settings-tab ${activeTab === "wan" ? "active" : ""}`}
          onClick={() => setActiveTab("wan")}
        >
          <Globe size={13} strokeWidth={1.8} />
          {t("remoteControl.tabWan", { defaultValue: "公网" })}
        </button>
      </div>

      {activeTab === "lan" ? (
        <>
          <div className="remote-port-setting">
            <div>
              <strong>
                {t("remoteControl.portLabel", {
                  defaultValue: "局域网监听端口",
                })}
                <ApiSettingsHintIcon
                  hint={t("remoteControl.portDescription", {
                    defaultValue:
                      "手机通过该端口访问本机，默认 8788；修改后服务会自动重启。",
                  })}
                />
              </strong>
            </div>
            <div className="remote-port-input">
              <input
                type="number"
                min="1"
                max="65535"
                value={portDraft}
                onChange={(event) => setPortDraft(event.target.value)}
                disabled={busy || !state}
                spellCheck={false}
                aria-label={t("remoteControl.portLabel", {
                  defaultValue: "局域网监听端口",
                })}
              />
              <button
                type="button"
                className="api-settings-action-btn primary"
                onClick={() => void savePort()}
                disabled={
                  busy ||
                  !state ||
                  portDraft.trim() === String(state.configuredPort)
                }
              >
                <Save size={15} strokeWidth={1.9} />
                <span>
                  {t("remoteControl.savePort", { defaultValue: "保存端口" })}
                </span>
              </button>
            </div>
          </div>

          <div className="remote-token-setting">
            <div className="remote-token-head">
              <strong>
                {t("remoteControl.lanTokenTitle", {
                  defaultValue: "局域网令牌",
                })}
                <ApiSettingsHintIcon
                  hint={t("remoteControl.lanTokenDescription", {
                    defaultValue:
                      "扫码或打开配对链接会自动携带令牌；固定后重启 Snow 也不变，也可以在手机上手动填写。",
                  })}
                />
              </strong>
              <span
                className={`remote-token-status ${state?.tokenPinned ? "pinned" : ""}`}
              >
                {state?.tokenPinned
                  ? t("remoteControl.tokenPinnedBadge", {
                      defaultValue: "已固定",
                    })
                  : t("remoteControl.tokenAutoBadge", {
                      defaultValue: "本次启动随机",
                    })}
              </span>
            </div>
            <div className="remote-token-value">
              <code>{maskedSecret(state?.token ?? "")}</code>
              <button
                type="button"
                className="api-settings-action-btn secondary"
                onClick={() => void copyToken(state?.token ?? "")}
                disabled={!state?.token || busy}
              >
                <Copy size={15} strokeWidth={1.9} />
                <span>
                  {t("remoteControl.tokenCopy", { defaultValue: "复制令牌" })}
                </span>
              </button>
            </div>
            <div className="remote-token-input">
              <input
                value={lanTokenDraft}
                placeholder={t("remoteControl.tokenPlaceholder", {
                  defaultValue: "输入自定义令牌（至少 24 个字符）",
                })}
                onChange={(event) => setLanTokenDraft(event.target.value)}
                disabled={busy || !state?.tokenStorageAvailable}
                spellCheck={false}
              />
              <button
                type="button"
                className="api-settings-action-btn secondary"
                onClick={() => setLanTokenDraft(generateToken())}
                disabled={busy || !state?.tokenStorageAvailable}
              >
                <RefreshCw size={15} strokeWidth={1.9} />
                <span>
                  {t("remoteControl.tokenGenerate", {
                    defaultValue: "重新生成",
                  })}
                </span>
              </button>
              <button
                type="button"
                className="api-settings-action-btn primary"
                onClick={() =>
                  void saveFixedToken("lan", lanTokenDraft || null)
                }
                disabled={
                  busy || !state?.tokenStorageAvailable || !lanTokenDraft.trim()
                }
              >
                <Save size={15} strokeWidth={1.9} />
                <span>
                  {t("remoteControl.tokenPin", { defaultValue: "确定更换" })}
                </span>
              </button>
              {state?.tokenPinned ? (
                <button
                  type="button"
                  className="api-settings-action-btn secondary"
                  onClick={() => void saveFixedToken("lan", null)}
                  disabled={busy}
                >
                  <RotateCcw size={15} strokeWidth={1.9} />
                  <span>
                    {t("remoteControl.tokenUnpin", {
                      defaultValue: "取消固定",
                    })}
                  </span>
                </button>
              ) : null}
            </div>
            <p className="remote-pairing-note">
              {t("remoteControl.rotateNote", {
                defaultValue: "更换后，已配对手机及尚未发送的附件会立即失效。",
              })}
            </p>
            {state && !state.tokenStorageAvailable ? (
              <div className="remote-pairing-message error" role="alert">
                {t("remoteControl.tokenStorageUnavailable", {
                  defaultValue: "系统安全存储不可用，无法保存令牌。",
                })}
              </div>
            ) : null}
          </div>

          {state?.enabled ? (
            <div className="remote-pairing-layout">
              <section
                className="remote-pairing-qr"
                aria-label={t("remoteControl.lanQrAria", {
                  defaultValue: "配对二维码",
                })}
              >
                <div className="remote-qr-card">
                  {qrDataUrl ? (
                    <img
                      src={qrDataUrl}
                      alt={t("remoteControl.lanQrAlt", {
                        defaultValue: "Snow 手机远控配对二维码",
                      })}
                    />
                  ) : (
                    <Smartphone size={44} />
                  )}
                </div>
                <span
                  className={`remote-service-status ${state?.running ? "running" : ""}`}
                >
                  {state?.running
                    ? t("remoteControl.listeningOn", {
                        values: { port: state.port },
                        defaultValue: "正在监听 {{port}}",
                      })
                    : t("remoteControl.serviceNotRunning", {
                        defaultValue: "服务未运行",
                      })}
                </span>
              </section>

              <section className="remote-pairing-details">
                <label>
                  {t("remoteControl.lanAddress", {
                    defaultValue: "局域网地址",
                  })}
                </label>
                <CustomSelect
                  value={selectedUrl}
                  options={(state?.pairingUrls ?? []).map((url) => ({
                    value: url,
                    label: url.replace(/([?&]token=)[^&]+/, "$1••••••••"),
                  }))}
                  onChange={(value) => setSelectedUrl(value)}
                  disabled={busy || !state?.running}
                />
                <div className="remote-pairing-actions">
                  <button
                    type="button"
                    className="api-settings-action-btn secondary"
                    onClick={() => void copy()}
                    disabled={!selectedUrl || busy}
                  >
                    <Copy size={15} strokeWidth={1.9} />
                    <span>
                      {t("remoteControl.copyAddress", {
                        defaultValue: "复制地址",
                      })}
                    </span>
                  </button>
                </div>
              </section>
            </div>
          ) : (
            <p className="remote-pairing-hint">
              {t("remoteControl.lanDisabledHint", {
                defaultValue:
                  "开启上方的手机远控后，这里会显示局域网配对二维码与地址。",
              })}
            </p>
          )}
        </>
      ) : null}

      {activeTab === "wan" && state?.enabled ? (
        <>
          <div className="remote-tunnel-card">
            <div className="remote-tunnel-heading">
              <Server size={18} />
              <div>
                <strong>
                  {t("remoteControl.tunnelTitle", {
                    defaultValue: "自建服务器公网连接",
                  })}
                  <ApiSettingsHintIcon
                    hint={t("remoteControl.tunnelDescription", {
                      defaultValue:
                        "Snow 会自动生成隧道专用密钥；部署失败时不会保存凭据，验证成功后才会在本机加密保存。",
                    })}
                  />
                </strong>
              </div>
              <span
                className={`remote-service-status ${tunnel?.stage === "online" ? "running" : ""}`}
              >
                {tunnel
                  ? tunnelStageLabel[tunnel.stage]
                  : t("remoteControl.statusLoading", {
                      defaultValue: "读取中",
                    })}
              </span>
            </div>

            <div className="remote-tunnel-status-grid">
              <span>
                {t("remoteControl.localWan", { defaultValue: "本机 WAN" })}
              </span>
              <strong>
                {tunnel?.listenerPort
                  ? `127.0.0.1:${tunnel.listenerPort}`
                  : t("remoteControl.notListening", { defaultValue: "未监听" })}
              </strong>
              <span>
                {t("remoteControl.ssh2Tunnel", { defaultValue: "SSH2 隧道" })}
              </span>
              <strong>
                {tunnel
                  ? tunnelStageLabel[tunnel.stage]
                  : t("remoteControl.statusUnknown", { defaultValue: "未知" })}
              </strong>
              <span>
                {t("remoteControl.httpsProbe", { defaultValue: "HTTPS 探测" })}
              </span>
              <strong>
                {tunnel
                  ? endpointStageLabel[tunnel.endpoint.stage]
                  : endpointStageLabel.unchecked}
              </strong>
            </div>

            {!tunnel?.config.secureStorageAvailable ? (
              <div className="remote-pairing-message error" role="alert">
                {t("remoteControl.secureStorageUnavailable", {
                  defaultValue:
                    "系统安全存储不可用。为避免明文保存凭据，公网远控已禁用。",
                })}
              </div>
            ) : null}

            {tunnel?.config.configured ? (
              <section className="remote-config-card">
                <div className="remote-config-head">
                  <strong>
                    {t("remoteControl.configuredTitle", {
                      defaultValue: "已保存的公网配置",
                    })}
                  </strong>
                  <span
                    className={`remote-token-status ${tunnel.config.enabled ? "pinned" : ""}`}
                  >
                    {tunnel.config.enabled
                      ? t("remoteControl.configEnabledBadge", {
                          defaultValue: "已启用",
                        })
                      : t("remoteControl.configDisabledBadge", {
                          defaultValue: "已停用",
                        })}
                  </span>
                </div>

                {tunnel.config.ssh2.needsAuthorization ? (
                  <div className="remote-tunnel-guide-callout warning">
                    <strong>
                      {t("remoteControl.ssh2NeedsAuthorization", {
                        defaultValue:
                          "SSH2 配置已导入，但本机缺少隧道私钥；请使用“自动部署并连接”重新授权此设备。",
                      })}
                    </strong>
                  </div>
                ) : null}

                <div className="remote-tunnel-status-grid">
                  <>
                    <span>
                      {t("remoteControl.ssh2ServerAddr", {
                        defaultValue: "服务器地址",
                      })}
                    </span>
                    <strong>{tunnel.config.ssh2.serverAddr}</strong>
                    <span>
                      {t("remoteControl.ssh2TunnelPort", {
                        defaultValue: "SSH2 隧道端口",
                      })}
                    </span>
                    <strong>{String(tunnel.config.ssh2.serverPort)}</strong>
                    <span>
                      {t("remoteControl.sshUsername", {
                        defaultValue: "SSH 用户名",
                      })}
                    </span>
                    <strong>{tunnel.config.ssh2.username}</strong>
                    <span>
                      {t("remoteControl.ssh2RemotePort", {
                        defaultValue: "SSH2 隧道回环端口",
                      })}
                    </span>
                    <strong>{String(tunnel.config.ssh2.remotePort)}</strong>
                    <span>
                      {t("remoteControl.ssh2HostKeyFingerprint", {
                        defaultValue: "主机密钥指纹",
                      })}
                    </span>
                    <div className="remote-token-value">
                      <code title={tunnel.config.ssh2.hostKeyFingerprint}>
                        {tunnel.config.ssh2.hostKeyFingerprint.length > 32
                          ? `${tunnel.config.ssh2.hostKeyFingerprint.slice(0, 32)}…`
                          : tunnel.config.ssh2.hostKeyFingerprint}
                      </code>
                      <button
                        type="button"
                        className="api-settings-action-btn secondary"
                        onClick={() =>
                          void copyHostKeyFingerprint(
                            tunnel.config.ssh2.hostKeyFingerprint,
                          )
                        }
                      >
                        <Copy size={15} strokeWidth={1.9} />
                        <span>
                          {t("remoteControl.copyFingerprint", {
                            defaultValue: "复制指纹",
                          })}
                        </span>
                      </button>
                    </div>
                    <span>
                      {t("remoteControl.publicOrigin", {
                        defaultValue: "手机 HTTPS 地址",
                      })}
                    </span>
                    <strong>{tunnel.config.publicOrigin}</strong>
                    <span>
                      {t("remoteControl.credentialsLabel", {
                        defaultValue: "加密凭据",
                      })}
                    </span>
                    <strong>
                      {tunnel.config.ssh2.hasPrivateKey
                        ? t("remoteControl.credentialsSavedSsh2", {
                            defaultValue: "隧道私钥已保存",
                          })
                        : t("remoteControl.credentialsMissingSsh2", {
                            defaultValue: "缺少隧道私钥",
                          })}
                    </strong>
                  </>
                  <span>
                    {t("remoteControl.autoConnectLabel", {
                      defaultValue: "启动时自动连接",
                    })}
                  </span>
                  <strong>
                    {tunnel.config.autoConnect
                      ? t("remoteControl.autoConnectOn", {
                          defaultValue: "已开启",
                        })
                      : t("remoteControl.autoConnectOff", {
                          defaultValue: "已关闭",
                        })}
                  </strong>
                </div>

                <div className="remote-pairing-actions">
                  {tunnel.stage === "stopped" || tunnel.stage === "failed" ? (
                    <button
                      type="button"
                      className="api-settings-action-btn primary"
                      onClick={() => void connectTunnel()}
                      disabled={
                        busy ||
                        !tunnel.config.enabled ||
                        !tunnel.config.secureStorageAvailable
                      }
                    >
                      <Power size={15} strokeWidth={1.9} />
                      <span>
                        {t("remoteControl.connectNow", {
                          defaultValue: "连接公网",
                        })}
                      </span>
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="api-settings-action-btn secondary"
                      onClick={() => void disconnect()}
                      disabled={busy}
                    >
                      <Unplug size={15} strokeWidth={1.9} />
                      <span>
                        {t("remoteControl.disconnectNow", {
                          defaultValue: "断开连接",
                        })}
                      </span>
                    </button>
                  )}
                  <button
                    type="button"
                    className="api-settings-action-btn secondary"
                    onClick={toggleManualForm}
                    disabled={busy || !tunnel.config.secureStorageAvailable}
                  >
                    <Settings2 size={15} strokeWidth={1.9} />
                    <span>
                      {wanMode === "manual"
                        ? t("remoteControl.editConfigClose", {
                            defaultValue: "收起表单",
                          })
                        : t("remoteControl.editConfig", {
                            defaultValue: "编辑配置",
                          })}
                    </span>
                  </button>
                  <button
                    type="button"
                    className="api-settings-action-btn secondary"
                    onClick={() => void exportConfig()}
                    disabled={busy || !tunnel.config.secureStorageAvailable}
                  >
                    <Download size={15} strokeWidth={1.9} />
                    <span>
                      {t("remoteControl.exportBundle", {
                        defaultValue: "导出配置包",
                      })}
                    </span>
                  </button>
                  <button
                    type="button"
                    className="api-settings-action-btn secondary remote-nav-danger"
                    onClick={() => setConfirmingRemove(true)}
                    disabled={busy || confirmingRemove}
                  >
                    <Trash2 size={15} strokeWidth={1.9} />
                    <span>
                      {t("remoteControl.removeConfig", {
                        defaultValue: "移除配置",
                      })}
                    </span>
                  </button>
                </div>

                {!tunnel.config.enabled ? (
                  <p className="remote-pairing-note">
                    {t("remoteControl.configDisabledHint", {
                      defaultValue:
                        "该配置当前已停用：在“编辑配置”中勾选“启用公网远控”并保存后即可连接。",
                    })}
                  </p>
                ) : null}

                <div className="remote-tunnel-guide-callout warning">
                  <strong>
                    {t("remoteControl.disconnectWarningTitle", {
                      defaultValue: "“断开连接”不会撤销手机登录。",
                    })}
                  </strong>
                  <span>
                    {t("remoteControl.disconnectWarningText", {
                      defaultValue:
                        "手机丢失或链接泄露时，请在“公网令牌”里重新生成并确定更换，让旧手机连接立即失效。",
                    })}
                  </span>
                </div>
              </section>
            ) : (
              <section className="remote-config-empty">
                <strong>
                  {t("remoteControl.configEmptyTitle", {
                    defaultValue: "还没有公网配置",
                  })}
                </strong>
                <p>
                  {t("remoteControl.configEmptyText", {
                    defaultValue:
                      "部署一台自己的服务器，或使用已有服务器的配置包、连接信息接入公网。",
                  })}
                </p>
              </section>
            )}

            <div className="import-settings-tabs" role="tablist">
              <button
                type="button"
                role="tab"
                aria-selected={wanMode === "deploy"}
                className={`import-settings-tab ${wanMode === "deploy" ? "active" : ""}`}
                onClick={() => toggleWanMode("deploy")}
              >
                <Server size={13} strokeWidth={1.8} />
                {t("remoteControl.deployNewServer", {
                  defaultValue: "部署新服务器",
                })}
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={wanMode === "import"}
                className={`import-settings-tab ${wanMode === "import" ? "active" : ""}`}
                onClick={() => toggleWanMode("import")}
              >
                <FileUp size={13} strokeWidth={1.8} />
                {t("remoteControl.importBundle", {
                  defaultValue: "导入已有配置包",
                })}
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={wanMode === "manual"}
                className={`import-settings-tab ${wanMode === "manual" ? "active" : ""}`}
                onClick={toggleManualForm}
              >
                <Settings2 size={13} strokeWidth={1.8} />
                {t("remoteControl.manualConfig", {
                  defaultValue: "手动填写连接信息",
                })}
              </button>
            </div>

            {wanMode === "manual" ? (
              <section className="remote-config-form">
                <div className="remote-config-head">
                  <strong>
                    {tunnel?.config.configured
                      ? t("remoteControl.manualFormTitleEdit", {
                          defaultValue: "编辑公网配置",
                        })
                      : t("remoteControl.manualFormTitleNew", {
                          defaultValue: "填写公网连接信息",
                        })}
                  </strong>
                </div>
                {tunnel?.config.ssh2.configured ? (
                  <>
                    <div className="remote-config-head">
                      <strong>
                        {t("remoteControl.ssh2SummaryTitle", {
                          defaultValue: "SSH2 隧道详情",
                        })}
                      </strong>
                    </div>
                    <div className="remote-tunnel-status-grid">
                      <span>
                        {t("remoteControl.ssh2ServerAddr", {
                          defaultValue: "服务器地址",
                        })}
                      </span>
                      <strong>{tunnel?.config.ssh2.serverAddr}</strong>
                      <span>
                        {t("remoteControl.ssh2TunnelPort", {
                          defaultValue: "SSH2 隧道端口",
                        })}
                      </span>
                      <strong>{String(tunnel?.config.ssh2.serverPort)}</strong>
                      <span>
                        {t("remoteControl.sshUsername", {
                          defaultValue: "SSH 用户名",
                        })}
                      </span>
                      <strong>{tunnel?.config.ssh2.username}</strong>
                      <span>
                        {t("remoteControl.ssh2RemotePort", {
                          defaultValue: "SSH2 隧道回环端口",
                        })}
                      </span>
                      <strong>{String(tunnel?.config.ssh2.remotePort)}</strong>
                      <span>
                        {t("remoteControl.ssh2HostKeyFingerprint", {
                          defaultValue: "主机密钥指纹",
                        })}
                      </span>
                      <strong title={tunnel?.config.ssh2.hostKeyFingerprint}>
                        {(tunnel?.config.ssh2.hostKeyFingerprint ?? "").length >
                        32
                          ? `${(tunnel?.config.ssh2.hostKeyFingerprint ?? "").slice(0, 32)}…`
                          : tunnel?.config.ssh2.hostKeyFingerprint}
                      </strong>
                    </div>
                  </>
                ) : (
                  <p className="remote-pairing-note">
                    {t("remoteControl.ssh2ManualUnavailable", {
                      defaultValue:
                        "SSH2 隧道信息由“自动部署并连接”自动生成；本机还没有配置，请先在“部署新服务器”中完成授权。",
                    })}
                  </p>
                )}
                <div className="remote-tunnel-form">
                  <label className="remote-tunnel-check">
                    <input
                      type="checkbox"
                      checked={form.enabled}
                      onChange={(event) =>
                        setForm((current) => ({
                          ...current,
                          enabled: event.target.checked,
                        }))
                      }
                    />
                    {t("remoteControl.tunnelEnabled", {
                      defaultValue: "启用公网远控",
                    })}
                  </label>
                  <label className="remote-tunnel-check">
                    <input
                      type="checkbox"
                      checked={form.autoConnect}
                      onChange={(event) =>
                        setForm((current) => ({
                          ...current,
                          autoConnect: event.target.checked,
                        }))
                      }
                    />
                    {t("remoteControl.tunnelAutoConnect", {
                      defaultValue: "Snow 启动后自动连接",
                    })}
                  </label>

                  <label>
                    {t("remoteControl.publicOrigin", {
                      defaultValue: "手机 HTTPS 地址",
                    })}
                    <input
                      value={form.publicOrigin}
                      placeholder="https://snow.example.com"
                      onChange={(event) =>
                        setForm((current) => ({
                          ...current,
                          publicOrigin: event.target.value,
                        }))
                      }
                      spellCheck={false}
                    />
                  </label>
                </div>

                <div className="remote-pairing-actions">
                  <button
                    type="button"
                    className="api-settings-action-btn primary"
                    onClick={() => void saveAndConnect()}
                    disabled={
                      busy ||
                      !tunnel?.config.secureStorageAvailable ||
                      !tunnel?.config.ssh2.configured
                    }
                  >
                    <Power size={15} strokeWidth={1.9} />
                    <span>
                      {form.enabled
                        ? t("remoteControl.saveAndConnect", {
                            defaultValue: "保存并连接",
                          })
                        : t("remoteControl.saveAndDisable", {
                            defaultValue: "保存并关闭公网",
                          })}
                    </span>
                  </button>
                  <button
                    type="button"
                    className="api-settings-action-btn secondary"
                    onClick={closeManualForm}
                    disabled={busy}
                  >
                    <span>{t("common.cancel", { defaultValue: "取消" })}</span>
                  </button>
                </div>
              </section>
            ) : null}

            {wanMode === "import" ? (
              <section className="remote-import-panel">
                <div className="remote-config-head">
                  <strong>
                    {t("remoteControl.importBundle", {
                      defaultValue: "导入已有配置包",
                    })}
                  </strong>
                </div>
                <p className="remote-pairing-note">
                  {t("remoteControl.importBundleHint", {
                    defaultValue:
                      "已有其他 Snow 生成的配置包时，导入会覆盖本机保存的公网配置。",
                  })}
                </p>
                <div className="remote-pairing-actions">
                  <button
                    type="button"
                    className="api-settings-action-btn primary"
                    onClick={() => void importConfig()}
                    disabled={busy || !tunnel?.config.secureStorageAvailable}
                  >
                    <FileUp size={15} strokeWidth={1.9} />
                    <span>
                      {t("remoteControl.importBundle", {
                        defaultValue: "导入已有配置包",
                      })}
                    </span>
                  </button>
                </div>
              </section>
            ) : null}

            {wanMode === "deploy" ? (
              <section className="remote-tunnel-guide-content">
                <p className="remote-pairing-note">
                  {tunnel?.config.configured
                    ? t("remoteControl.redeploySummary", {
                        defaultValue:
                          "更换服务器 / 重新部署（共 4 步，Snow 负责安装）",
                      })
                    : t("remoteControl.guideSummary", {
                        defaultValue:
                          "第一次公网部署（共 4 步，Snow 负责安装）",
                      })}
                </p>
                <div className="remote-tunnel-guide-callout">
                  <strong>
                    {t("remoteControl.guideCalloutTitle", {
                      defaultValue: "只在同一 Wi-Fi 使用时，不需要服务器。",
                    })}
                  </strong>
                  <span>
                    {t("remoteControl.guideCalloutText", {
                      defaultValue:
                        "直接扫描上方局域网二维码即可；下面的公网配置可以保持关闭。",
                    })}
                  </span>
                </div>

                <section className="remote-deploy-step">
                  <h4>
                    <b>1</b>{" "}
                    {t("remoteControl.step1Title", {
                      defaultValue: "购买前确认：只需要服务器和域名",
                    })}
                  </h4>
                  <ul>
                    <li>
                      <strong>
                        {t("remoteControl.step1ServerLabel", {
                          defaultValue: "Linux 公网服务器：",
                        })}
                      </strong>
                      {t("remoteControl.step1ServerText", {
                        defaultValue:
                          "任意厂商，Ubuntu 22+、Debian 11+、Fedora 44+、CentOS Stream/RHEL/Rocky/AlmaLinux 9+，仅 x86_64/amd64、root 或免密码 sudo、systemd、独立公网 IPv4、长期运行；至少 1 核 1 GB。不要买抢占式、竞价、Windows、数据库、GPU 或预装面板套餐。",
                      })}
                    </li>
                    <li>
                      <strong>
                        {t("remoteControl.step1DomainLabel", {
                          defaultValue: "一个付费域名：",
                        })}
                      </strong>
                      {t("remoteControl.step1DomainText", {
                        defaultValue:
                          "任意注册商和后缀均可。不需要购买 SSL 证书、CDN、云解析高级版、建站或企业邮箱。",
                      })}
                    </li>
                    <li>
                      <strong>
                        {t("remoteControl.step1CredentialLabel", {
                          defaultValue: "服务器登录凭据：",
                        })}
                      </strong>
                      {t("remoteControl.step1CredentialText", {
                        defaultValue:
                          "root 密码或 SSH 私钥。它不是云厂商账号密码；服务器没有初始密码时，在服务器控制台点“设置/重置密码”。",
                      })}
                    </li>
                  </ul>
                </section>

                <section className="remote-deploy-step">
                  <h4>
                    <b>2</b>{" "}
                    {t("remoteControl.step2Title", {
                      defaultValue: "先去两个控制台完成这些设置",
                    })}
                  </h4>
                  <p>
                    <strong>
                      {t("remoteControl.step2DnsLabel", {
                        defaultValue: "域名控制台 → DNS/域名解析 → 添加记录：",
                      })}
                    </strong>
                  </p>
                  <div
                    className="remote-deploy-table"
                    role="table"
                    aria-label={t("remoteControl.dnsTableAria", {
                      defaultValue: "DNS 记录",
                    })}
                  >
                    <strong>
                      {t("remoteControl.dnsType", { defaultValue: "类型" })}
                    </strong>
                    <strong>
                      {t("remoteControl.dnsHost", { defaultValue: "主机记录" })}
                    </strong>
                    <strong>
                      {t("remoteControl.dnsValue", { defaultValue: "记录值" })}
                    </strong>
                    <code>A</code>
                    <code>snow</code>
                    <code>
                      {deployForm.serverIp.trim() ||
                        t("remoteControl.serverIpLabel", {
                          defaultValue: "服务器公网 IP",
                        })}
                    </code>
                  </div>
                  <small>
                    {t("remoteControl.step2DnsHintPrefix", {
                      defaultValue: "主机记录只填",
                    })}{" "}
                    <code>snow</code>{" "}
                    {t("remoteControl.step2DnsHintSuffix", {
                      defaultValue: "，不要填写完整域名；线路和 TTL 保持默认。",
                    })}
                    {normalizedRootDomain
                      ? ` ${t("remoteControl.step2DnsHintDomains", {
                          values: { rootDomain: normalizedRootDomain },
                          defaultValue: "保存后会得到 snow.{{rootDomain}}。",
                        })}`
                      : ""}
                  </small>
                  <p>
                    <strong>
                      {t("remoteControl.step2FirewallLabel", {
                        defaultValue:
                          "服务器控制台 → 防火墙/安全组 → 添加入站规则：",
                      })}
                    </strong>
                  </p>
                  <div className="remote-deploy-ports">
                    <code>TCP 22</code>
                    <span>
                      {t("remoteControl.portPurposeSsh", {
                        defaultValue: "Snow 登录服务器",
                      })}
                    </span>
                    <code>TCP 80</code>
                    <span>
                      {t("remoteControl.portPurposeAcme", {
                        defaultValue: "自动申请 HTTPS 证书",
                      })}
                    </span>
                    <code>TCP 443</code>
                    <span>
                      {t("remoteControl.portPurposeHttps", {
                        defaultValue: "手机 HTTPS 访问",
                      })}
                    </span>
                    <code>
                      TCP {deployForm.ssh2TunnelPort.trim() || "7001"}
                    </code>
                    <span>
                      {t("remoteControl.portPurposeTunnel", {
                        defaultValue: "Snow 桌面隧道",
                      })}
                    </span>
                  </div>
                  <div className="remote-tunnel-guide-callout warning">
                    <strong>
                      {t("remoteControl.step2ClosedPortWarning", {
                        values: {
                          port: deployForm.ssh2RemotePort.trim() || "18080",
                        },
                        defaultValue: "不要开放 TCP {{port}}。",
                      })}
                    </strong>
                    <span>
                      {t("remoteControl.step2ClosedPortText", {
                        defaultValue:
                          "它只能在服务器内部使用，Snow 部署结束时会自动检查。",
                      })}
                    </span>
                  </div>
                </section>

                <section className="remote-deploy-step">
                  <h4>
                    <b>3</b>{" "}
                    {t("remoteControl.step3Title", {
                      defaultValue: "再填写 Snow 连接信息",
                    })}
                  </h4>
                  <div className="remote-simple-deploy-form">
                    <label>
                      {t("remoteControl.serverIpLabel", {
                        defaultValue: "服务器公网 IP",
                      })}
                      <ApiSettingsHintIcon
                        hint={t("remoteControl.serverIpHint", {
                          defaultValue:
                            "服务器详情页中的“公网 IP / 公网 IPv4”，不是私有 IP。",
                        })}
                      />
                      <input
                        value={deployForm.serverIp}
                        placeholder={t("remoteControl.serverIpPlaceholder", {
                          defaultValue: "填写服务器公网 IPv4",
                        })}
                        onChange={(event) => {
                          setDnsCheck(null);
                          setDeployForm((current) => ({
                            ...current,
                            serverIp: event.target.value,
                          }));
                        }}
                        spellCheck={false}
                      />
                    </label>
                    <label>
                      {t("remoteControl.rootDomainLabel", {
                        defaultValue: "你的根域名",
                      })}
                      <ApiSettingsHintIcon
                        hint={t("remoteControl.rootDomainHint", {
                          defaultValue:
                            "填写买到的域名，如 example.com；不要加 snow、https 或路径。",
                        })}
                      />
                      <input
                        value={deployForm.rootDomain}
                        placeholder={t("remoteControl.rootDomainExample", {
                          defaultValue: "例如 example.com",
                        })}
                        onChange={(event) => {
                          setDnsCheck(null);
                          setDeployForm((current) => ({
                            ...current,
                            rootDomain: event.target.value,
                          }));
                        }}
                        spellCheck={false}
                      />
                    </label>
                    <label>
                      {t("remoteControl.sshUsername", {
                        defaultValue: "SSH 用户名",
                      })}
                      <ApiSettingsHintIcon
                        hint={t("remoteControl.sshUsernameHint", {
                          defaultValue:
                            "Ubuntu/Debian、CentOS/RHEL 系密码登录通常填 root；云厂商一键登录显示的 admin 不一定能用。",
                        })}
                      />
                      <input
                        value={deployForm.sshUsername}
                        onChange={(event) =>
                          setDeployForm((current) => ({
                            ...current,
                            sshUsername: event.target.value,
                          }))
                        }
                        spellCheck={false}
                      />
                    </label>
                    <label>
                      {t("remoteControl.sshPort", { defaultValue: "SSH 端口" })}
                      <ApiSettingsHintIcon
                        hint={t("remoteControl.sshPortHint", {
                          defaultValue:
                            "服务器远程连接页面显示的端口，未修改时通常是 22。",
                        })}
                      />
                      <input
                        type="number"
                        min="1"
                        max="65535"
                        value={deployForm.sshPort}
                        onChange={(event) =>
                          setDeployForm((current) => ({
                            ...current,
                            sshPort: event.target.value,
                          }))
                        }
                      />
                    </label>
                    <>
                      <label>
                        {t("remoteControl.ssh2TunnelPort", {
                          defaultValue: "SSH2 隧道端口",
                        })}
                        <ApiSettingsHintIcon
                          hint={t("remoteControl.ssh2TunnelPortHint", {
                            defaultValue:
                              "专用 snow-tunnel-sshd 的监听端口，需要在安全组放行；未修改时通常是 7001。",
                          })}
                        />
                        <input
                          type="number"
                          min="1"
                          max="65535"
                          value={deployForm.ssh2TunnelPort}
                          onChange={(event) =>
                            setDeployForm((current) => ({
                              ...current,
                              ssh2TunnelPort: event.target.value,
                            }))
                          }
                        />
                      </label>
                      <label>
                        {t("remoteControl.ssh2RemotePort", {
                          defaultValue: "SSH2 隧道回环端口",
                        })}
                        <ApiSettingsHintIcon
                          hint={t("remoteControl.ssh2RemotePortHint", {
                            defaultValue:
                              "服务器内部回环端口，只由 Caddy 使用；无需在安全组放行。",
                          })}
                        />
                        <input
                          type="number"
                          min="1"
                          max="65535"
                          value={deployForm.ssh2RemotePort}
                          onChange={(event) =>
                            setDeployForm((current) => ({
                              ...current,
                              ssh2RemotePort: event.target.value,
                            }))
                          }
                        />
                      </label>
                    </>
                    <label>
                      {t("remoteControl.authMethod", {
                        defaultValue: "登录方式",
                      })}
                      <ApiSettingsHintIcon
                        hint={t("remoteControl.authMethodHint", {
                          defaultValue:
                            "新手建议使用在服务器控制台设置的 SSH 密码。",
                        })}
                      />
                      <CustomSelect
                        value={deployForm.authMethod}
                        options={authMethodOptions}
                        onChange={(value) =>
                          setDeployForm((current) => ({
                            ...current,
                            authMethod: value as "password" | "privateKey",
                          }))
                        }
                      />
                    </label>
                    {deployForm.authMethod === "password" ? (
                      <label>
                        {t("remoteControl.authPassword", {
                          defaultValue: "SSH 密码",
                        })}
                        <ApiSettingsHintIcon
                          hint={t("remoteControl.sshPasswordHint", {
                            defaultValue:
                              "服务器 root 密码，不是阿里云/腾讯云等网站的登录密码。",
                          })}
                        />
                        <input
                          type="password"
                          value={deployForm.password}
                          onChange={(event) =>
                            setDeployForm((current) => ({
                              ...current,
                              password: event.target.value,
                            }))
                          }
                          autoComplete="new-password"
                          placeholder={t(
                            "remoteControl.sshPasswordPlaceholder",
                            {
                              defaultValue: "只在本次部署期间保存在内存中",
                            },
                          )}
                        />
                      </label>
                    ) : (
                      <>
                        <label className="remote-simple-deploy-key">
                          {t("remoteControl.sshKeyFile", {
                            defaultValue: "SSH 私钥文件",
                          })}
                          <ApiSettingsHintIcon
                            hint={t("remoteControl.sshKeyFileHint", {
                              defaultValue:
                                "选择创建服务器或绑定密钥对时下载到本机的私钥文件。",
                            })}
                          />
                          <span>
                            <input
                              value={deployForm.privateKeyPath}
                              readOnly
                              placeholder={t(
                                "remoteControl.sshKeyFilePlaceholder",
                                { defaultValue: "请选择私钥文件" },
                              )}
                            />
                            <button
                              type="button"
                              className="api-settings-action-btn secondary"
                              onClick={() => void selectPrivateKey()}
                              disabled={busy}
                            >
                              {t("remoteControl.selectFile", {
                                defaultValue: "选择",
                              })}
                            </button>
                          </span>
                        </label>
                        <label>
                          {t("remoteControl.passphrase", {
                            defaultValue: "私钥密码（没有可留空）",
                          })}
                          <input
                            type="password"
                            value={deployForm.passphrase}
                            onChange={(event) =>
                              setDeployForm((current) => ({
                                ...current,
                                passphrase: event.target.value,
                              }))
                            }
                            autoComplete="new-password"
                          />
                        </label>
                      </>
                    )}
                  </div>
                </section>

                <section className="remote-deploy-step">
                  <h4>
                    <b>4</b>{" "}
                    {t("remoteControl.step4Title", {
                      defaultValue: "检测成功后再自动部署",
                    })}
                  </h4>
                  <p>
                    {t("remoteControl.step4Text", {
                      defaultValue:
                        "先点“检测 DNS”。snow 解析通过后，再点“自动部署并连接”；之后受限 sshd、Caddy、证书与配置导入都由 Snow 处理。",
                    })}
                  </p>

                  {dnsCheck ? (
                    <div className="remote-dns-check-results">
                      {dnsCheck.records.map((record) => (
                        <span key={record.host}>
                          {record.ready ? (
                            <Check
                              size={11}
                              strokeWidth={2.4}
                              aria-hidden="true"
                            />
                          ) : (
                            <X size={11} strokeWidth={2.4} aria-hidden="true" />
                          )}{" "}
                          {record.name} → {record.expectedValue}
                        </span>
                      ))}
                    </div>
                  ) : null}

                  <div className="remote-pairing-actions">
                    <button
                      type="button"
                      className="api-settings-action-btn secondary"
                      onClick={() => void checkDns()}
                      disabled={busy}
                    >
                      <RefreshCw
                        size={15}
                        strokeWidth={1.9}
                        className={checkingDns ? "spin" : ""}
                      />
                      <span>
                        {t("remoteControl.checkDns", {
                          defaultValue: "检测 DNS",
                        })}
                      </span>
                    </button>
                    <button
                      type="button"
                      className="api-settings-action-btn primary"
                      onClick={() => void deployServer()}
                      disabled={busy || !tunnel?.config.secureStorageAvailable}
                    >
                      <Server size={15} strokeWidth={1.9} />
                      <span>
                        {t("remoteControl.deployConnect", {
                          defaultValue: "自动部署并连接",
                        })}
                      </span>
                    </button>
                    {deploymentActive ? (
                      <button
                        type="button"
                        className="api-settings-action-btn secondary"
                        onClick={() => void cancelDeployment()}
                      >
                        {t("remoteControl.cancelDeploy", {
                          defaultValue: "取消部署",
                        })}
                      </button>
                    ) : null}
                  </div>
                  {deployProgress ? (
                    <div className="remote-deploy-progress" role="status">
                      <RefreshCw
                        size={15}
                        className={
                          deployProgress.stage === "completed" ? "" : "spin"
                        }
                      />
                      <span>
                        {t(
                          `remoteControl.deployStage.${deployProgress.stage}`,
                          {
                            defaultValue: deployProgress.message,
                          },
                        )}
                      </span>
                    </div>
                  ) : null}
                </section>
              </section>
            ) : null}
            {tunnel?.error ? (
              <div className="remote-pairing-message error" role="alert">
                {tunnel.error.message}
              </div>
            ) : null}
          </div>

          <div className="remote-token-setting">
            <div className="remote-token-head">
              <strong>
                {t("remoteControl.wanTokenTitle", { defaultValue: "公网令牌" })}
                <ApiSettingsHintIcon
                  hint={t("remoteControl.wanTokenDescription", {
                    defaultValue:
                      "公网二维码与地址始终携带该令牌，重启 Snow 或重连隧道都不变；也可以让手机手动填写。",
                  })}
                />
              </strong>
              {state?.wan.token ? (
                <span className="remote-token-status pinned">
                  {t("remoteControl.wanTokenSavedBadge", {
                    defaultValue: "长期有效",
                  })}
                </span>
              ) : null}
            </div>
            <div className="remote-token-value">
              <code>{maskedSecret(state?.wan.token ?? "")}</code>
              <button
                type="button"
                className="api-settings-action-btn secondary"
                onClick={() => void copyToken(state?.wan.token ?? "")}
                disabled={!state?.wan.token || busy}
              >
                <Copy size={15} strokeWidth={1.9} />
                <span>
                  {t("remoteControl.tokenCopy", { defaultValue: "复制令牌" })}
                </span>
              </button>
            </div>
            <div className="remote-token-input">
              <input
                value={wanTokenDraft}
                placeholder={t("remoteControl.tokenPlaceholder", {
                  defaultValue: "输入自定义令牌（至少 24 个字符）",
                })}
                onChange={(event) => setWanTokenDraft(event.target.value)}
                disabled={busy || !state?.tokenStorageAvailable}
                spellCheck={false}
              />
              <button
                type="button"
                className="api-settings-action-btn secondary"
                onClick={() => setWanTokenDraft(generateToken())}
                disabled={busy || !state?.tokenStorageAvailable}
              >
                <RefreshCw size={15} strokeWidth={1.9} />
                <span>
                  {t("remoteControl.tokenGenerate", {
                    defaultValue: "重新生成",
                  })}
                </span>
              </button>
              <button
                type="button"
                className="api-settings-action-btn primary"
                onClick={() =>
                  void saveFixedToken("wan", wanTokenDraft || null)
                }
                disabled={
                  busy || !state?.tokenStorageAvailable || !wanTokenDraft.trim()
                }
              >
                <Save size={15} strokeWidth={1.9} />
                <span>
                  {t("remoteControl.tokenPin", { defaultValue: "确定更换" })}
                </span>
              </button>
            </div>
            <p className="remote-pairing-note">
              {t("remoteControl.wanTokenPinnedNote", {
                defaultValue:
                  "公网入口未连接时保存会在隧道连接后生效；更换后需要重新扫码。",
              })}
            </p>
            {state && !state.tokenStorageAvailable ? (
              <div className="remote-pairing-message error" role="alert">
                {t("remoteControl.tokenStorageUnavailable", {
                  defaultValue: "系统安全存储不可用，无法保存令牌。",
                })}
              </div>
            ) : null}
          </div>

          {state?.wan.enabled ? (
            <div className="remote-pairing-layout">
              <section
                className="remote-pairing-qr"
                aria-label={t("remoteControl.wanQrAria", {
                  defaultValue: "公网配对二维码",
                })}
              >
                <div className="remote-qr-card">
                  {wanQrDataUrl ? (
                    <img
                      src={wanQrDataUrl}
                      alt={t("remoteControl.wanQrAlt", {
                        defaultValue: "Snow 公网远控配对二维码",
                      })}
                    />
                  ) : (
                    <Smartphone size={44} />
                  )}
                </div>
                <span
                  className={`remote-service-status ${tunnel?.stage === "online" ? "running" : ""}`}
                >
                  {tunnel?.stage === "online"
                    ? t("remoteControl.wanVerified", {
                        defaultValue: "公网入口已验证",
                      })
                    : t("remoteControl.wanPending", {
                        defaultValue: "公网入口待验证",
                      })}
                </span>
              </section>
              <section className="remote-pairing-details">
                <label>
                  {t("remoteControl.selfHostedServer", {
                    defaultValue: "自建服务器",
                  })}
                </label>
                <div className="remote-pairing-message">
                  {state.wan.publicOrigin}
                </div>
                <p className="remote-pairing-note">
                  {t("remoteControl.wanNote", {
                    values: { port: state.wan.localPort },
                    defaultValue:
                      "本机隧道端口 {{port}}。二维码与地址携带当前令牌，更换令牌后需要重新扫码。",
                  })}
                </p>
              </section>
            </div>
          ) : null}
        </>
      ) : null}

      {activeTab === "wan" && !state?.enabled ? (
        <p className="remote-pairing-hint">
          {t("remoteControl.wanDisabledHint", {
            defaultValue:
              "公网远控依赖本机服务，请先在“局域网”标签页开启手机远控。",
          })}
        </p>
      ) : null}

      <AutoDismissNotice
        message={notice?.message ?? ""}
        tone={notice?.tone ?? "info"}
        onDismiss={dismissNotice}
      />

      <ConfirmDialog
        open={confirmingRemove}
        title={t("remoteControl.removeConfigConfirmTitle", {
          defaultValue: "确认移除本机保存的公网配置？",
        })}
        message={t("remoteControl.removeConfigConfirmText", {
          defaultValue:
            "将断开公网隧道并删除加密保存的隧道私钥；服务器上的隧道服务与 Caddy 不受影响，重新部署或导入配置包后可再次连接。",
        })}
        confirmLabel={t("remoteControl.removeConfigConfirm", {
          defaultValue: "确认移除",
        })}
        cancelLabel={t("common.cancel", { defaultValue: "取消" })}
        variant="danger"
        isConfirming={busy}
        onConfirm={() => void removeConfig()}
        onCancel={() => setConfirmingRemove(false)}
      />
    </div>
  );
}
