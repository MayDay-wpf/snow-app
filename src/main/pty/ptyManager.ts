import { type WebContents } from "electron";
import { createRequire } from "node:module";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { tmpdir } from "node:os";
import type { IPty } from "node-pty";

import {
  connectSsh,
  disconnectSsh,
  isSshPath,
  parseSshUrl,
  type SshConnectParams,
} from "../ssh/sshManager";
import {
  getDecryptedSecret,
  getSshCredential,
  toSshJumpParams,
} from "../ssh/sshCredentials";
import {
  formatSshKnownHost,
  getSshHostKey,
  type SshHostKeyRecord,
} from "../ssh/sshHostKeys";
import { ensureConptyDll } from "./conptyDllHelper";
import { buildPtyEnvironment } from "./ptyEnvironment";
import { native } from "../native/nativeBridge";

const require2 = createRequire(import.meta.url);

// Lazy-load node-pty to avoid blocking module loading and window creation.
// The native conpty.node binding is heavy and only needed when a terminal
// session is actually spawned.
let _nodePty: typeof import("node-pty") | null = null;
const getNodePty = (): typeof import("node-pty") => {
  if (!_nodePty) {
    _nodePty = require2("node-pty") as typeof import("node-pty");
  }
  return _nodePty;
};

export type PtySessionOptions = {
  cwd: string;
  cols: number;
  rows: number;
  shellPath?: string;
  /** Internal-only validated command used to attach an existing Remote Job. */
  remoteCommand?: string;
  sessionId?: string;
};

export type PtySession = {
  id: string;
  pty: IPty;
  webContents: WebContents;
  /** 待发送的 PTY 输出（按 16ms / 64KB 阈值合并后一次性 IPC）。 */
  outputBuffer: string;
  outputTimer: ReturnType<typeof setTimeout> | null;
};

const PTY_OUTPUT_CHANNEL = "pty:output";
const PTY_EXIT_CHANNEL = "pty:exit";

/**
 * 构建、日志刷屏时 node-pty 每秒可产生上千个数据块，逐块 IPC 会让主进程与
 * 渲染进程同时过载。按 16ms 或 64KB 阈值合并后发送，延迟不可感知，而 IPC
 * 次数与渲染层的字符串处理量都能下降一个数量级。
 */
const PTY_OUTPUT_FLUSH_MS = 16;
const PTY_OUTPUT_FLUSH_CHARS = 64 * 1024;

const flushPtyOutput = (session: PtySession): void => {
  if (session.outputTimer) {
    clearTimeout(session.outputTimer);
    session.outputTimer = null;
  }
  if (session.outputBuffer.length === 0) {
    return;
  }
  const data = session.outputBuffer;
  session.outputBuffer = "";
  const webContents = session.webContents;
  if (!webContents.isDestroyed()) {
    webContents.send(PTY_OUTPUT_CHANNEL, { id: session.id, data });
  }
};

const enqueuePtyOutput = (session: PtySession, data: string): void => {
  session.outputBuffer += data;
  if (session.outputBuffer.length >= PTY_OUTPUT_FLUSH_CHARS) {
    flushPtyOutput(session);
    return;
  }
  if (session.outputTimer) {
    return;
  }
  session.outputTimer = setTimeout(
    () => flushPtyOutput(session),
    PTY_OUTPUT_FLUSH_MS,
  );
};

const sessions = new Map<string, PtySession>();

/**
 * 交接中的会话：终端 tab 迁移到独立面板窗口（或从独立窗口还原）时，源端 tab
 * 卸载会触发 kill，这里先登记保留，目标端挂载并 claim 后才解除。保留期间
 * killPty / killAllPtyForWebContents 一律跳过，避免迁移途中误杀正在运行的 shell。
 */
const handoffPtyIds = new Set<string>();

const generatePtyId = (): string =>
  `pty-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

/**
 * Windows 兜底 shell：当 native detect_terminals() 未检测到任何终端时使用
 * （正常情况不会走到这里——detect 顺序与 Rust 侧完全一致：PowerShell Core →
 * PowerShell → CMD → Git Bash → COMSPEC）。优先级 pwsh > powershell > cmd。
 */
const getShell = (): string => {
  if (process.platform === "win32") {
    for (const name of ["pwsh.exe", "powershell.exe"]) {
      const resolved = resolveWindowsExecutable(name);
      if (isAbsolute(resolved)) {
        return resolved;
      }
    }
    return process.env.COMSPEC ?? "cmd.exe";
  }
  return process.env.SHELL ?? "/bin/zsh";
};

const getShellArgs = (): string[] => {
  if (process.platform === "win32") {
    return [];
  }
  return ["-l"];
};

/**
 * Resolve a bare command name (e.g. "ssh") to a full absolute path on
 * Windows. node-pty's ConPTY native module (startProcess) does NOT search
 * PATH like POSIX execvp — it requires an absolute or at least resolvable
 * path. On non-Windows platforms the name is returned unchanged.
 */
const resolveWindowsExecutable = (name: string): string => {
  if (process.platform !== "win32") {
    return name;
  }
  // Already an absolute path — nothing to resolve.
  if (isAbsolute(name)) {
    return name;
  }

  const withExt = name.toLowerCase().endsWith(".exe") ? name : `${name}.exe`;

  // Check well-known OpenSSH location first (fastest path).
  const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
  const openSshPath = join(systemRoot, "System32", "OpenSSH", withExt);
  if (existsSync(openSshPath)) {
    return openSshPath;
  }

  // Search PATH directories.
  const pathDirs = (process.env.PATH ?? "").split(delimiter);
  for (const dir of pathDirs) {
    if (!dir) continue;
    const candidate = join(dir, withExt);
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  // Fallback: return original name and let node-pty surface the error.
  return name;
};

/**
 * Whether the given shell path points to WSL (wsl.exe). WSL must be launched
 * with `--cd <windowsPath>` because it does NOT inherit the Windows process
 * working directory as a Linux cwd — without `--cd` the Linux shell starts in
 * the user's home directory instead of the project directory.
 */
const isWslShell = (shellPath: string): boolean => {
  const base =
    shellPath
      .replace(/\\/g, "/")
      .split("/")
      .pop()
      ?.toLowerCase()
      .replace(/\.exe$/, "") ?? "";
  return base === "wsl";
};

const sanitizeEnv = (options: PtySessionOptions): Record<string, string> =>
  buildPtyEnvironment(process.env, {
    sessionId: options.sessionId,
    cwd: options.cwd,
  });

/**
 * node-pty 的 spawn-helper 是可执行文件，但 1.1.0 的 npm 包把它以 0644 发布
 * （prebuilds/darwin-*），且 node-pty 自己的 post-install.js 只处理 build/Release，
 * 从不修复 prebuilds。缺执行位时 macOS 上 posix_spawn 直接失败，终端报
 * 「posix_spawnp failed.」。这里在启动时补上执行位。
 *
 * 打包后 require.resolve 解析到 asar 内的虚拟路径，而 Electron 的 asar
 * 文件系统不支持 chmod（抛 ENOENT），所以必须先映射到 asar.unpacked 下的
 * 真实文件再操作，否则这个修复在正式包里形同虚设。
 */
const toUnpackedPath = (path: string): string =>
  path.includes("app.asar.unpacked")
    ? path
    : path.replace("app.asar", "app.asar.unpacked");

const ensureExecutable = (path: string): void => {
  const realPath = toUnpackedPath(path);
  if (!existsSync(realPath)) {
    return;
  }
  // 已有任一执行位时跳过，避免每次启动都做一次无意义的 chmod 系统调用。
  if ((statSync(realPath).mode & 0o111) !== 0) {
    return;
  }
  try {
    chmodSync(realPath, 0o755);
  } catch (error) {
    // 只读安装目录等场景无法修复，交给 node-pty 抛出真实错误。
    console.warn(`Failed to mark spawn-helper executable: ${realPath}`, error);
  }
};

const ensureSpawnHelperExecutable = (): void => {
  if (process.platform === "win32") {
    return;
  }
  try {
    // 与 node-pty lib/utils.js 的查找顺序保持一致：build/Release →
    // build/Debug → prebuilds/<platform>-<arch>。
    const ptyModulePath = require2.resolve("node-pty");
    const ptyDir = dirname(ptyModulePath);
    const ptyRoot = dirname(ptyDir);
    const platformArch = `${process.platform}-${process.arch}`;
    for (const dir of [
      join(ptyRoot, "build", "Release"),
      join(ptyRoot, "build", "Debug"),
      join(ptyRoot, "prebuilds", platformArch),
      join(ptyDir, "build", "Release"),
      join(ptyDir, "build", "Debug"),
      join(ptyDir, "prebuilds", platformArch),
    ]) {
      ensureExecutable(join(dir, "spawn-helper"));
    }
  } catch (error) {
    console.warn("Failed to locate node-pty spawn-helper", error);
  }
};

ensureSpawnHelperExecutable();

/**
 * Whether the bundled conpty.dll is available for useConptyDll mode.
 * When true, kill() avoids forking conpty_console_list_agent.js (which
 * triggers AttachConsole failures in Electron). Falls back to false when
 * the DLL cannot be located or copied, degrading to kernel32 ConPTY.
 */
const conptyDllAvailable = ensureConptyDll();

type SshSpawnConfig = {
  shell: string;
  args: string[];
  /** True only after a host key has passed the application's verifier. */
  hostKeyVerified: boolean;
  dispose: () => void;
  /** Plaintext password to auto-inject when SSH prompts. Undefined = no injection. */
  password?: string;
  /** Plaintext passphrase for private key, auto-injected on prompt. */
  passphrase?: string;
};

const buildSshConnectParams = (
  host: string,
  port: number,
  username: string,
): SshConnectParams | null => {
  const credential = getSshCredential(host, port, username);
  if (!credential) {
    return null;
  }

  const params: SshConnectParams = {
    host,
    port,
    username,
    authMethod: credential.authMethod,
  };
  if (credential.privateKeyPath) {
    params.privateKeyPath = credential.privateKeyPath;
  }
  if (credential.encryptedSecret) {
    const secret = getDecryptedSecret(host, port, username);
    if (secret) {
      if (credential.authMethod === "password") {
        params.password = secret;
      } else {
        params.passphrase = secret;
      }
    }
  }
  if (credential.jump) {
    params.jump = toSshJumpParams(credential.jump);
  }
  return params;
};

const resolveVerifiedSshHostKey = async (params: {
  host: string;
  port: number;
  username: string;
}): Promise<SshHostKeyRecord> => {
  const existing = getSshHostKey(params.host, params.port);
  if (existing && formatSshKnownHost(existing)) {
    return existing;
  }

  // Fingerprint-only records from earlier versions must be upgraded through
  // the same ssh2 host verifier before the system SSH client can use them.
  const connectParams = buildSshConnectParams(
    params.host,
    params.port,
    params.username,
  );
  if (!connectParams) {
    throw new Error(
      "SSH terminal blocked: connect to this workspace first to verify its host key",
    );
  }

  const sessionId = await connectSsh(connectParams);
  try {
    const verified = getSshHostKey(params.host, params.port);
    if (verified && formatSshKnownHost(verified)) {
      return verified;
    }
  } finally {
    disconnectSsh(sessionId);
  }
  throw new Error("SSH terminal blocked: verified host key is unavailable");
};

const createKnownHostsFile = (
  records: SshHostKeyRecord[],
): {
  path: string;
  dispose: () => void;
} => {
  const entries: string[] = [];
  for (const record of records) {
    const entry = formatSshKnownHost(record);
    if (!entry) {
      throw new Error("SSH terminal blocked: verified host key is unavailable");
    }
    entries.push(entry);
  }
  if (entries.length === 0) {
    throw new Error("SSH terminal blocked: verified host key is unavailable");
  }
  const contents = entries.join("");

  const directory = mkdtempSync(join(tmpdir(), "snow-ssh-known-hosts-"));
  const path = join(directory, "known_hosts");
  try {
    try {
      chmodSync(directory, 0o700);
    } catch {
      // Some platforms cannot apply POSIX modes.
    }
    writeFileSync(path, contents, { encoding: "utf-8", mode: 0o600 });
    try {
      chmodSync(path, 0o600);
    } catch {
      // Some platforms cannot apply POSIX modes.
    }
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
  return {
    path,
    dispose: () => rmSync(directory, { recursive: true, force: true }),
  };
};

const buildSshSpawnConfig = async (
  cwd: string,
  remoteCommand?: string,
): Promise<SshSpawnConfig | null> => {
  if (!isSshPath(cwd)) {
    return null;
  }

  let parsed;
  try {
    parsed = parseSshUrl(cwd);
  } catch {
    return null;
  }

  const { host, port, username, remotePath } = parsed;
  // Look up stored credentials
  const credential = getSshCredential(host, port, username);
  // 经跳板机时临时 known_hosts 必须同时固定跳板机与目标机的公钥，
  // 否则 StrictHostKeyChecking=yes 会在跳板机上失败。
  const hostKeys = [await resolveVerifiedSshHostKey({ host, port, username })];
  if (credential?.jump) {
    hostKeys.push(
      await resolveVerifiedSshHostKey({
        host: credential.jump.host,
        port: credential.jump.port,
        username: credential.jump.username,
      }),
    );
  }
  const knownHosts = createKnownHostsFile(hostKeys);
  const sshArgs: string[] = [];

  sshArgs.push("-o", `UserKnownHostsFile=${knownHosts.path}`);
  sshArgs.push("-o", "StrictHostKeyChecking=yes");
  sshArgs.push("-o", "ConnectTimeout=10");

  if (port !== 22) {
    sshArgs.push("-p", String(port));
  }

  const config: SshSpawnConfig = {
    shell: resolveWindowsExecutable("ssh"),
    args: sshArgs,
    hostKeyVerified: true,
    dispose: knownHosts.dispose,
  };

  if (credential) {
    if (credential.authMethod === "privateKey" && credential.privateKeyPath) {
      config.args = ["-i", credential.privateKeyPath, ...config.args];
      // Retrieve passphrase if stored
      const passphrase = getDecryptedSecret(host, port, username);
      if (passphrase) {
        config.passphrase = passphrase;
      }
    } else if (credential.authMethod === "password") {
      const password = getDecryptedSecret(host, port, username);
      if (password) {
        config.password = password;
      }
    }
    // agent auth: no extra args needed

    if (credential.jump) {
      const jump = credential.jump;
      config.args.push(
        "-o",
        `ProxyJump=${jump.username}@${jump.host}:${jump.port}`,
      );
      // 跳板机也用密码认证时无法分辨提示来自哪一跳，交给用户手动输入，
      // 避免把目标机密码注入到跳板机的提示上。
      if (jump.authMethod === "password") {
        config.password = undefined;
      }
    }
  }

  const destination = `${username}@${host}`;
  // Only Main Process creates remoteCommand after validating the Job backend.
  // Renderer-created terminals always get a normal login shell.
  if (remoteCommand) {
    config.args.push("-tt", destination, remoteCommand);
  } else if (remotePath && remotePath !== "/") {
    // After connecting, cd to the remote path and start a login shell.
    config.args.push("-t", destination, `cd '${remotePath}' && exec $SHELL -l`);
  } else {
    config.args.push("-t", destination, `exec $SHELL -l`);
  }

  return config;
};

export const createPtySession = async (
  webContents: WebContents,
  options: PtySessionOptions,
): Promise<string> => {
  const id = generatePtyId();
  const customShell = options.shellPath?.trim();
  const isWindows = process.platform === "win32";

  const sshConfig = await buildSshSpawnConfig(
    options.cwd,
    options.remoteCommand,
  );

  let shell: string;
  let shellArgs: string[];
  let spawnCwd: string | undefined;

  if (sshConfig) {
    shell = sshConfig.shell;
    shellArgs = sshConfig.args;
    spawnCwd = undefined; // Remote path, not a local cwd
  } else if (customShell) {
    // 显式指定了 shell：含路径分隔符的路径必须真实存在，否则直接报错，
    // 绝不静默回退到默认 shell（避免"传参成功但实际用的是别的 shell"）。
    // 纯文件名（如 wsl.exe / bash）允许，由 spawn 时按 PATH 解析。
    const looksLikePath =
      customShell.includes("/") || customShell.includes("\\");
    if (looksLikePath && !existsSync(customShell)) {
      throw new Error(`Terminal shell not found: ${customShell}`);
    }
    shell = customShell;
    if (isWindows && isWslShell(customShell)) {
      // WSL ignores the Windows process cwd; pass the project directory via
      // `--cd` so the Linux shell opens inside it. wsl.exe accepts Windows
      // paths and translates them to /mnt/<drive>/... automatically.
      shellArgs =
        options.cwd && options.cwd.trim() ? ["--cd", options.cwd] : [];
      spawnCwd = undefined;
    } else {
      shellArgs = isWindows ? [] : ["-l"];
      spawnCwd = options.cwd || undefined;
    }
  } else {
    // 未显式指定：与 bash 工具（Rust resolve_shell_and_args）完全同源，
    // 使用 native detect_terminals() 的检测顺序取第一个，保证智能体命令
    // 与集成终端使用同一个默认 shell。detect 失败时 getShell() 兜底。
    const detected = await native.detectTerminals();
    const detectedPath = detected[0]?.path?.trim();
    shell = detectedPath || getShell();
    shellArgs = getShellArgs();
    spawnCwd = options.cwd || undefined;
  }

  // Windows 下刷新 PATH（注册表 + 继承的合并值，是继承环境的严格超集），
  // 补齐应用启动后新增的条目；WSL 不注入，Windows PATH 会破坏 Linux PATH。
  const ptyEnv = sanitizeEnv(options);
  if (isWindows && !isWslShell(shell)) {
    try {
      const refreshedPath = await native.resolveLoginPathForTerminal();
      if (refreshedPath) {
        ptyEnv.PATH = refreshedPath;
      }
    } catch {
      // 刷新失败时沿用继承环境，不影响终端创建
    }
  }

  let pty: IPty;
  try {
    pty = getNodePty().spawn(shell, shellArgs, {
      name: "xterm-256color",
      cols: options.cols,
      rows: options.rows,
      cwd: spawnCwd,
      env: ptyEnv,
      // Electron already has a console attached, so the default ConPTY kill path
      // (which forks conpty_console_list_agent.js and calls AttachConsole) throws
      // "AttachConsole failed". Setting useConptyDll routes kill() through a
      // different code path that avoids the fork entirely. Falls back to false
      // when conpty.dll is unavailable (ensureConptyDll could not locate or copy
      // it), degrading to kernel32 ConPTY with a delayed kill cleanup.
      useConptyDll: conptyDllAvailable,
    });
  } catch (error) {
    sshConfig?.dispose();
    throw error;
  }

  const session: PtySession = {
    id,
    pty,
    webContents,
    outputBuffer: "",
    outputTimer: null,
  };
  sessions.set(id, session);

  // Password/passphrase auto-injection for SSH sessions
  if (
    sshConfig?.hostKeyVerified &&
    (sshConfig.password || sshConfig.passphrase)
  ) {
    let injectedPassword = false;
    let injectedPassphrase = false;

    const disposable = pty.onData((data: string) => {
      const lowerData = data.toLowerCase();

      if (
        !injectedPassword &&
        sshConfig.password &&
        (lowerData.includes("password:") || lowerData.includes("password for"))
      ) {
        setTimeout(() => {
          pty.write(sshConfig.password! + "\r");
        }, 100);
        injectedPassword = true;
      }

      if (
        !injectedPassphrase &&
        sshConfig.passphrase &&
        (lowerData.includes("passphrase") ||
          lowerData.includes("enter passphrase"))
      ) {
        setTimeout(() => {
          pty.write(sshConfig.passphrase! + "\r");
        }, 100);
        injectedPassphrase = true;
      }

      // Dispose once both secrets are injected (or no longer needed)
      if (injectedPassword && (!sshConfig.passphrase || injectedPassphrase)) {
        disposable.dispose();
      }
    });
  }

  pty.onData((data: string) => {
    enqueuePtyOutput(session, data);
  });

  pty.onExit(({ exitCode }: { exitCode: number }) => {
    // 退出前把缓冲中的尾部输出发完，避免最后几行丢失。
    flushPtyOutput(session);
    const wc = sessions.get(id)?.webContents;
    if (wc && !wc.isDestroyed()) {
      wc.send(PTY_EXIT_CHANNEL, { id, exitCode });
    }
    sessions.delete(id);
    handoffPtyIds.delete(id);
    sshConfig?.dispose();
  });

  return id;
};

export const writePtyInput = (id: string, data: string): void => {
  const session = sessions.get(id);
  if (!session) {
    throw new Error(`PTY session not found: ${id}`);
  }
  session.pty.write(data.replace(/\r\n/g, "\r").replace(/\n/g, "\r"));
};

export const resizePty = (id: string, cols: number, rows: number): void => {
  const session = sessions.get(id);
  if (!session) {
    return;
  }
  // ConPTY 对每次 resize(即使尺寸相同)都会全屏重绘,与正在输出的内容
  // 交错会造成行重叠;极小尺寸(隐藏 tab / 未布局完成的容器算出的
  // 2 列)的 reflow 更是破坏性的。钳制最小值并跳过无变化的 resize。
  const safeCols = Math.max(2, Math.floor(cols));
  const safeRows = Math.max(1, Math.floor(rows));
  if (session.pty.cols === safeCols && session.pty.rows === safeRows) {
    return;
  }
  try {
    session.pty.resize(safeCols, safeRows);
  } catch {
    // Ignore
  }
};

export const killPty = (id: string): void => {
  // 交接中的会话归属尚未转移，由目标窗口 claim 后再决定去留。
  if (handoffPtyIds.has(id)) {
    return;
  }
  const session = sessions.get(id);
  if (!session) {
    return;
  }
  try {
    session.pty.kill();
  } catch {
    // Already dead
  }
  sessions.delete(id);
};

/**
 * 登记会话进入交接状态（tab 即将从源渲染进程移除，目标渲染进程随后 claim）。
 * 仅标记，不改变会话归属与输出通道。
 */
export const reservePtyForHandoff = (id: string): void => {
  if (sessions.has(id)) {
    handoffPtyIds.add(id);
  }
};

/**
 * 目标渲染进程挂载已有会话时调用：解除交接标记，并把输出通道与回收归属
 * 切换到该 webContents。会话不存在（进程已退出）时返回 false。
 */
export const claimPtyForWebContents = (
  id: string,
  webContents: WebContents,
): boolean => {
  const session = sessions.get(id);
  if (!session) {
    handoffPtyIds.delete(id);
    return false;
  }
  handoffPtyIds.delete(id);
  session.webContents = webContents;
  return true;
};

/** 当前存活的终端会话数（供托盘 tooltip 等模块展示）。 */
export const getActivePtyCount = (): number => sessions.size;

/**
 * 回收某个渲染进程名下的会话（窗口关闭时调用）。交接中的会话保留，等待
 * 目标窗口 claim，避免迁移途中被误杀。
 */
export const killAllPtyForWebContents = (webContents: WebContents): void => {
  for (const [id, session] of sessions) {
    if (session.webContents === webContents && !handoffPtyIds.has(id)) {
      try {
        session.pty.kill();
      } catch {
        // Already dead
      }
      sessions.delete(id);
    }
  }
};

export { PTY_OUTPUT_CHANNEL, PTY_EXIT_CHANNEL };
