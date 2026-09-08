import { safeStorage, webContents } from "electron";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { ensureWebContentsDebugger } from "./browserNetworkRecorder";

/**
 * 内置浏览器登录态（cookie + localStorage）的加密保存与恢复。
 *
 * 安全设计（含 3 个加固点）：
 * 1. 文件始终经 safeStorage（OS 级加密）落盘，绝不明文；safeStorage 不可用时拒绝保存。
 * 2. 备份文件（恢复前自动生成）同样加密。
 * 3. 错误信息/返回值只含文件名与计数，绝不包含 cookie 值或 localStorage 内容。
 * 4. 文件名白名单（纯文件名，路径由本模块拼接），杜绝路径穿越。
 * 5. localStorage 注入带 origin 校验，绝不跨源写入。
 * 6. 文件带 magic header + 版本号 + schema 校验，损坏/伪造文件直接拒绝。
 */

/** 应用用户数据资产统一放 ~/.snowapp/（与 browser-passwords 等目录约定一致）。 */
export const STATE_DIR = join(homedir(), ".snowapp", "browser-state");
const BACKUP_DIR = join(STATE_DIR, "backups");

/** 文件名白名单：纯文件名，最长 100 字符（Rust 入口同步校验）。 */
export const STATE_FILE_NAME_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;

/** 文件头：9 字节 magic + 1 字节版本。 */
const FILE_MAGIC = "SNOWSTATE";
export const FILE_VERSION = 1;

export type StoredCookie = {
  name: string;
  value: string;
  domain: string;
  path: string;
  /** 秒级 Unix 时间戳；会话 cookie 无此字段。 */
  expires?: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite?: "None" | "Lax" | "Strict" | "unspecified";
};

type StoredOrigin = {
  origin: string;
  items: Record<string, string>;
};

export type StorageStateFile = {
  version: number;
  capturedAt: string;
  capturedUrl: string;
  cookies: StoredCookie[];
  localStorage: StoredOrigin[];
};

const ensureStateDirs = (): void => {
  mkdirSync(STATE_DIR, { recursive: true });
  mkdirSync(BACKUP_DIR, { recursive: true });
};

const restrictFilePermissions = (filePath: string): void => {
  try {
    chmodSync(filePath, 0o600);
  } catch {
    // Windows 无 POSIX 权限位，忽略。
  }
};

const resolveStateFilePath = (fileName: string): string => {
  if (!STATE_FILE_NAME_PATTERN.test(fileName)) {
    throw new Error(
      "Invalid state file name: only letters, digits, dot, dash and underscore are allowed (max 100 chars)",
    );
  }
  return join(STATE_DIR, fileName);
};

// ===== 收集 =====

export const collectSessionCookies = async (
  targetSession: Electron.Session,
): Promise<StoredCookie[]> => {
  const cookies = await targetSession.cookies.get({});
  return cookies.map((cookie) => ({
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain ?? "",
    path: cookie.path ?? "/",
    ...(cookie.expirationDate !== undefined
      ? { expires: cookie.expirationDate }
      : {}),
    httpOnly: cookie.httpOnly ?? false,
    secure: cookie.secure ?? false,
    // Electron sameSite 风格 → CDP/存储风格。
    sameSite: (cookie.sameSite === "no_restriction"
      ? "None"
      : cookie.sameSite === "lax"
        ? "Lax"
        : cookie.sameSite === "strict"
          ? "Strict"
          : "unspecified") as StoredCookie["sameSite"],
  }));
};

/** 提取主 frame 的 localStorage（含同源 iframe 自动共享；跨域 iframe 不收集）。 */
const collectLocalStorage = async (
  contents: Electron.WebContents,
): Promise<StoredOrigin[]> => {
  if (!contents.debugger.isAttached()) {
    return [];
  }
  try {
    const result = (await contents.debugger.sendCommand("Runtime.evaluate", {
      expression: `(() => {
        try {
          const items = {};
          for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key !== null) items[key] = localStorage.getItem(key) || '';
          }
          return { origin: location.origin, items };
        } catch { return null; }
      })()`,
      returnByValue: true,
    })) as { result?: { value?: unknown; exceptionDetails?: unknown } };
    if (result.result?.exceptionDetails) {
      return [];
    }
    const value = result.result?.value as {
      origin?: unknown;
      items?: unknown;
    } | null;
    if (
      value &&
      typeof value.origin === "string" &&
      value.items !== null &&
      typeof value.items === "object" &&
      !Array.isArray(value.items)
    ) {
      return [
        { origin: value.origin, items: value.items as Record<string, string> },
      ];
    }
    return [];
  } catch {
    return [];
  }
};

const collectBrowserState = async (
  contents: Electron.WebContents,
): Promise<StorageStateFile> => ({
  version: FILE_VERSION,
  capturedAt: new Date().toISOString(),
  capturedUrl: contents.getURL(),
  cookies: await collectSessionCookies(contents.session),
  localStorage: await collectLocalStorage(contents),
});

// ===== 加密落盘 / 读取 =====

export const writeEncryptedStateFile = (
  filePath: string,
  state: StorageStateFile,
): void => {
  const plain = Buffer.from(JSON.stringify(state), "utf8");
  const encrypted = safeStorage.encryptString(plain.toString("utf8"));
  ensureStateDirs();
  writeFileSync(
    filePath,
    Buffer.concat([
      Buffer.from(FILE_MAGIC + String(FILE_VERSION), "utf8"),
      encrypted,
    ]),
  );
  restrictFilePermissions(filePath);
};

export const readEncryptedStateFile = (filePath: string): StorageStateFile => {
  if (!existsSync(filePath)) {
    throw new Error("State file does not exist");
  }
  const data = readFileSync(filePath);
  const header = data.subarray(0, FILE_MAGIC.length + 1).toString("utf8");
  if (!header.startsWith(FILE_MAGIC)) {
    throw new Error(
      "Invalid state file: missing magic header (corrupted or not a Snow state file)",
    );
  }
  const version = Number(header[FILE_MAGIC.length] ?? "0");
  if (version !== FILE_VERSION) {
    throw new Error(`Unsupported state file version: ${version}`);
  }
  let plain: string;
  try {
    plain = safeStorage.decryptString(data.subarray(FILE_MAGIC.length + 1));
  } catch {
    throw new Error(
      "Failed to decrypt state file (wrong OS user or file modified)",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(plain);
  } catch {
    throw new Error("State file contains invalid JSON (corrupted)");
  }
  const state = parsed as StorageStateFile;
  if (
    state === null ||
    typeof state !== "object" ||
    state.version !== FILE_VERSION ||
    !Array.isArray(state.cookies) ||
    !Array.isArray(state.localStorage)
  ) {
    throw new Error(
      "State file schema validation failed (corrupted or forged)",
    );
  }
  return state;
};

// ===== 恢复 =====

const sameSiteToElectron = (
  sameSite: StoredCookie["sameSite"],
): "unspecified" | "no_restriction" | "lax" | "strict" => {
  switch (sameSite) {
    case "None":
      return "no_restriction";
    case "Lax":
      return "lax";
    case "Strict":
      return "strict";
    default:
      return "unspecified";
  }
};

export const restoreSessionCookies = async (
  targetSession: Electron.Session,
  cookies: StoredCookie[],
): Promise<{ restored: number; failures: number }> => {
  const nowSec = Date.now() / 1000;
  // 已过期的持久 Cookie 恢复无意义，直接跳过（会话 Cookie 无 expires，保留）。
  const pending = cookies.filter(
    (cookie) => cookie.expires === undefined || cookie.expires > nowSec,
  );
  const restoreOne = async (cookie: StoredCookie): Promise<void> => {
    const host = cookie.domain.replace(/^\./, "");
    const scheme = cookie.secure ? "https" : "http";
    // 域 Cookie（带前导点，如 .google.com）必须显式传 domain，否则 Electron
    // 会存成 host-only Cookie，不会发送给子域名（mail.google.com 等），
    // 恢复后登录态失效。
    const isDomainCookie = cookie.domain.startsWith(".");
    // Chromium 拒绝 SameSite=None 且非 Secure 的组合；降级保证写入成功。
    let sameSite = sameSiteToElectron(cookie.sameSite);
    if (sameSite === "no_restriction" && !cookie.secure) {
      sameSite = "unspecified";
    }
    await targetSession.cookies.set({
      url: `${scheme}://${host}${cookie.path || "/"}`,
      name: cookie.name,
      value: cookie.value,
      secure: cookie.secure,
      httpOnly: cookie.httpOnly,
      ...(isDomainCookie ? { domain: cookie.domain } : {}),
      ...(cookie.expires !== undefined
        ? { expirationDate: cookie.expires }
        : {}),
      sameSite,
    });
  };
  let restored = 0;
  let failures = 0;
  // 分批并发：数千级 Cookie 秒级完成（逐条 await 过慢）。
  const BATCH_SIZE = 100;
  for (let i = 0; i < pending.length; i += BATCH_SIZE) {
    const results = await Promise.allSettled(
      pending.slice(i, i + BATCH_SIZE).map(restoreOne),
    );
    for (const result of results) {
      if (result.status === "fulfilled") {
        restored++;
      } else {
        failures++;
      }
    }
  }
  return { restored, failures };
};

const LOCAL_STORAGE_INJECTION = (
  origin: string,
  items: Record<string, string>,
): string =>
  `(() => {
    if (location.origin !== ${JSON.stringify(origin)}) return;
    try {
      const items = ${JSON.stringify(items)};
      for (const key of Object.keys(items)) localStorage.setItem(key, items[key]);
    } catch {}
  })();`;

/** 恢复 localStorage：立即注入当前页面 + 注册常驻脚本覆盖后续导航（均带 origin 校验）。 */
const restoreLocalStorage = async (
  contents: Electron.WebContents,
  localStorage: StoredOrigin[],
): Promise<{ origins: number; failures: number }> => {
  let origins = 0;
  let failures = 0;
  for (const entry of localStorage) {
    const script = LOCAL_STORAGE_INJECTION(entry.origin, entry.items);
    try {
      await contents.debugger.sendCommand("Runtime.evaluate", {
        expression: script,
      });
      await contents.debugger.sendCommand(
        "Page.addScriptToEvaluateOnNewDocument",
        {
          source: script,
        },
      );
      origins++;
    } catch {
      failures++;
    }
  }
  return { origins, failures };
};

// ===== 对外接口 =====

export const saveBrowserStorageState = async (
  webContentsId: number,
  fileName?: string,
): Promise<{
  ok: boolean;
  file: string;
  cookieCount: number;
  originCount: number;
  capturedUrl: string;
  capturedAt: string;
  error?: string;
}> => {
  if (!safeStorage.isEncryptionAvailable()) {
    return {
      ok: false,
      file: "",
      cookieCount: 0,
      originCount: 0,
      capturedUrl: "",
      capturedAt: "",
      error:
        "System encryption is unavailable (safeStorage); refusing to save login state as plaintext. Enable the OS keyring and retry.",
    };
  }
  const contents = webContents.fromId(webContentsId);
  if (!contents || contents.isDestroyed()) {
    return {
      ok: false,
      file: "",
      cookieCount: 0,
      originCount: 0,
      capturedUrl: "",
      capturedAt: "",
      error: "Browser web contents no longer exists",
    };
  }
  try {
    await ensureWebContentsDebugger(contents);
  } catch {
    // localStorage 提取可能不可用，cookies 仍可保存。
  }
  const state = await collectBrowserState(contents);
  const resolvedName =
    fileName && STATE_FILE_NAME_PATTERN.test(fileName)
      ? fileName
      : `state-${new Date().toISOString().replace(/[:.]/g, "-")}.bin`;
  const filePath = join(STATE_DIR, resolvedName);
  writeEncryptedStateFile(filePath, state);
  return {
    ok: true,
    file: resolvedName,
    cookieCount: state.cookies.length,
    originCount: state.localStorage.length,
    capturedUrl: state.capturedUrl,
    capturedAt: state.capturedAt,
  };
};

export const restoreBrowserStorageState = async (
  webContentsId: number,
  fileName: string,
): Promise<{
  ok: boolean;
  restoredCookies: number;
  cookieFailures: number;
  restoredOrigins: number;
  originFailures: number;
  backupFile: string | null;
  warnings: string[];
  error?: string;
}> => {
  const contents = webContents.fromId(webContentsId);
  if (!contents || contents.isDestroyed()) {
    return {
      ok: false,
      restoredCookies: 0,
      cookieFailures: 0,
      restoredOrigins: 0,
      originFailures: 0,
      backupFile: null,
      warnings: [],
      error: "Browser web contents no longer exists",
    };
  }
  let state: StorageStateFile;
  try {
    state = readEncryptedStateFile(resolveStateFilePath(fileName));
  } catch (error) {
    return {
      ok: false,
      restoredCookies: 0,
      cookieFailures: 0,
      restoredOrigins: 0,
      originFailures: 0,
      backupFile: null,
      warnings: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }

  const warnings: string[] = [];
  let backupFile: string | null = null;

  // 加固点 2：恢复前自动备份当前状态（同样加密）。
  if (safeStorage.isEncryptionAvailable()) {
    try {
      const current = await collectBrowserState(contents);
      if (current.cookies.length > 0 || current.localStorage.length > 0) {
        const backupName = `backup-${Date.now()}-${fileName}`;
        writeEncryptedStateFile(join(BACKUP_DIR, backupName), current);
        backupFile = `backups/${backupName}`;
      }
    } catch {
      warnings.push("Failed to back up current browser state before restore");
    }
  }

  try {
    await ensureWebContentsDebugger(contents);
  } catch {
    warnings.push(
      "CDP session unavailable; localStorage restore will be skipped (cookies still restored)",
    );
  }

  const cookieResult = await restoreSessionCookies(
    contents.session,
    state.cookies,
  );
  if (cookieResult.failures > 0) {
    warnings.push(`${cookieResult.failures} cookie(s) failed to restore`);
  }

  let originResult = { origins: 0, failures: 0 };
  if (contents.debugger.isAttached()) {
    originResult = await restoreLocalStorage(contents, state.localStorage);
    if (originResult.failures > 0) {
      warnings.push(
        `${originResult.failures} origin(s) failed to restore localStorage`,
      );
    }
  }

  if (state.localStorage.length > 0 && state.capturedUrl) {
    warnings.push(
      `State was captured from ${state.capturedUrl}; localStorage only applies to matching origins`,
    );
  }

  return {
    ok: true,
    restoredCookies: cookieResult.restored,
    cookieFailures: cookieResult.failures,
    restoredOrigins: originResult.origins,
    originFailures: originResult.failures,
    backupFile,
    warnings,
  };
};

export const listBrowserCookies = async (
  webContentsId: number,
  domain?: string,
  showValues = false,
): Promise<unknown[]> => {
  const contents = webContents.fromId(webContentsId);
  if (!contents || contents.isDestroyed()) {
    return [];
  }
  const cookies = await contents.session.cookies.get(domain ? { domain } : {});
  return cookies
    .sort(
      (a, b) =>
        (a.domain ?? "").localeCompare(b.domain ?? "") ||
        (a.path ?? "").localeCompare(b.path ?? "") ||
        a.name.localeCompare(b.name),
    )
    .map((cookie) => ({
      name: cookie.name,
      domain: cookie.domain,
      path: cookie.path,
      expires: cookie.expirationDate,
      httpOnly: cookie.httpOnly,
      secure: cookie.secure,
      sameSite: cookie.sameSite,
      session: cookie.session,
      value: showValues
        ? cookie.value
        : `${cookie.value.slice(0, 4)}••••(${cookie.value.length} chars)`,
    }));
};

export const deleteBrowserCookie = async (
  webContentsId: number,
  name: string,
  domain: string,
): Promise<{ deleted: boolean }> => {
  const contents = webContents.fromId(webContentsId);
  if (!contents || contents.isDestroyed()) {
    throw new Error("Browser web contents no longer exists");
  }
  // Electron cookies.remove(url, name) 按 URL 精确删除：先按 name+domain 查
  // 出全部匹配 cookie，再逐个用其 secure/path 构造 URL 删除。
  const matched = await contents.session.cookies.get({ name, domain });
  for (const cookie of matched) {
    const host = (cookie.domain ?? domain).replace(/^\./, "");
    const url = `${cookie.secure ? "https" : "http"}://${host}${cookie.path ?? "/"}`;
    await contents.session.cookies.remove(url, cookie.name);
  }
  return { deleted: matched.length > 0 };
};
