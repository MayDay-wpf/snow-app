import { type WebContents } from "electron";
import { createRequire } from "node:module";
import { chmodSync, existsSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import type { IPty } from "node-pty";

import { isSshPath, parseSshUrl } from "../ssh/sshManager";
import { getDecryptedSecret, getSshCredential } from "../ssh/sshCredentials";
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
  sessionId?: string;
};

export type PtySession = {
  id: string;
  pty: IPty;
  webContents: WebContents;
};

const PTY_OUTPUT_CHANNEL = "pty:output";
const PTY_EXIT_CHANNEL = "pty:exit";

const sessions = new Map<string, PtySession>();

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

const ensureSpawnHelperExecutable = (): void => {
  if (process.platform === "win32") {
    return;
  }
  try {
    const ptyModulePath = require2.resolve("node-pty");
    const ptyDir = dirname(ptyModulePath);
    const prebuildDir = join(
      ptyDir,
      "..",
      "prebuilds",
      `${process.platform}-${process.arch}`
    );
    const spawnHelperPath = join(prebuildDir, "spawn-helper");
    if (existsSync(spawnHelperPath)) {
      chmodSync(spawnHelperPath, 0o755);
    }
  } catch {
    // Ignore
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
  /** Plaintext password to auto-inject when SSH prompts. Undefined = no injection. */
  password?: string;
  /** Plaintext passphrase for private key, auto-injected on prompt. */
  passphrase?: string;
};

const buildSshSpawnConfig = (cwd: string): SshSpawnConfig | null => {
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
  const sshArgs: string[] = [];

  // Disable host key checking for smoother UX (can be improved later)
  sshArgs.push("-o", "StrictHostKeyChecking=accept-new");
  sshArgs.push("-o", "ConnectTimeout=10");

  if (port !== 22) {
    sshArgs.push("-p", String(port));
  }

  // Look up stored credentials
  const credential = getSshCredential(host, port, username);
  const config: SshSpawnConfig = {
    shell: resolveWindowsExecutable("ssh"),
    args: [...sshArgs, `${username}@${host}`],
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
  }

  // After connecting, cd to the remote path and start a login shell
  if (remotePath && remotePath !== "/") {
    config.args.push("-t", `cd '${remotePath}' && exec $SHELL -l`);
  } else {
    config.args.push("-t", `exec $SHELL -l`);
  }

  return config;
};

export const createPtySession = async (
  webContents: WebContents,
  options: PtySessionOptions
): Promise<string> => {
  const id = generatePtyId();
  const customShell = options.shellPath?.trim();
  const isWindows = process.platform === "win32";

  const sshConfig = buildSshSpawnConfig(options.cwd);

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

  const pty = getNodePty().spawn(shell, shellArgs, {
    name: "xterm-256color",
    cols: options.cols,
    rows: options.rows,
    cwd: spawnCwd,
    env: sanitizeEnv(options),
    // Electron already has a console attached, so the default ConPTY kill path
    // (which forks conpty_console_list_agent.js and calls AttachConsole) throws
    // "AttachConsole failed". Setting useConptyDll routes kill() through a
    // different code path that avoids the fork entirely. Falls back to false
    // when conpty.dll is unavailable (ensureConptyDll could not locate or copy
    // it), degrading to kernel32 ConPTY with a delayed kill cleanup.
    useConptyDll: conptyDllAvailable,
  });

  const session: PtySession = { id, pty, webContents };
  sessions.set(id, session);

  // Password/passphrase auto-injection for SSH sessions
  if (sshConfig && (sshConfig.password || sshConfig.passphrase)) {
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
    const wc = sessions.get(id)?.webContents;
    if (wc && !wc.isDestroyed()) {
      wc.send(PTY_OUTPUT_CHANNEL, { id, data });
    }
  });

  pty.onExit(({ exitCode }: { exitCode: number }) => {
    const wc = sessions.get(id)?.webContents;
    if (wc && !wc.isDestroyed()) {
      wc.send(PTY_EXIT_CHANNEL, { id, exitCode });
    }
    sessions.delete(id);
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
  try {
    session.pty.resize(cols, rows);
  } catch {
    // Ignore
  }
};

export const killPty = (id: string): void => {
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

/** 当前存活的终端会话数（供托盘 tooltip 等模块展示）。 */
export const getActivePtyCount = (): number => sessions.size;

export const killAllPtyForWebContents = (webContents: WebContents): void => {
  for (const [id, session] of sessions) {
    if (session.webContents === webContents) {
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
