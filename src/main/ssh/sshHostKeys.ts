import { app } from "electron";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

export type SshHostKeyRecord = {
  host: string;
  port: number;
  fingerprint: string;
  /** SSH public-key algorithm from the verified wire-format host key. */
  keyType?: string;
  /** Base64-encoded verified wire-format host key for OpenSSH known_hosts. */
  publicKey?: string;
  trustedAt: string;
};

const getHostKeyDirectory = (): string =>
  join(app.getPath("userData"), "ssh-host-keys");

const getHostKeyFilePath = (): string =>
  join(getHostKeyDirectory(), "known-hosts.json");

const getHostKeyId = (host: string, port: number): string =>
  `${host.trim().toLowerCase()}:${port}`;

const ensureHostKeyDirectory = (): void => {
  const directory = getHostKeyDirectory();
  if (!existsSync(directory)) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    return;
  }
  try {
    chmodSync(directory, 0o700);
  } catch {
    // Some platforms cannot apply POSIX modes.
  }
};

const readAllHostKeys = (): SshHostKeyRecord[] => {
  ensureHostKeyDirectory();
  const filePath = getHostKeyFilePath();
  if (!existsSync(filePath)) {
    return [];
  }

  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf-8")) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter(
      (value): value is SshHostKeyRecord =>
        typeof value === "object" &&
        value !== null &&
        typeof (value as SshHostKeyRecord).host === "string" &&
        typeof (value as SshHostKeyRecord).port === "number" &&
        typeof (value as SshHostKeyRecord).fingerprint === "string" &&
        (typeof (value as SshHostKeyRecord).keyType === "undefined" ||
          typeof (value as SshHostKeyRecord).keyType === "string") &&
        (typeof (value as SshHostKeyRecord).publicKey === "undefined" ||
          typeof (value as SshHostKeyRecord).publicKey === "string") &&
        typeof (value as SshHostKeyRecord).trustedAt === "string"
    );
  } catch {
    return [];
  }
};

const writeAllHostKeys = (records: SshHostKeyRecord[]): void => {
  ensureHostKeyDirectory();
  const filePath = getHostKeyFilePath();
  const temporaryPath = `${filePath}.tmp`;
  writeFileSync(temporaryPath, JSON.stringify(records, null, 2), {
    encoding: "utf-8",
    mode: 0o600,
  });
  try {
    chmodSync(temporaryPath, 0o600);
  } catch {
    // Some platforms cannot apply POSIX modes.
  }
  renameSync(temporaryPath, filePath);
};

export const getSshHostKey = (
  host: string,
  port: number
): SshHostKeyRecord | null => {
  const id = getHostKeyId(host, port);
  return (
    readAllHostKeys().find(
      (record) => getHostKeyId(record.host, record.port) === id
    ) ?? null
  );
};

export const saveSshHostKey = (params: {
  host: string;
  port: number;
  fingerprint: string;
  keyType?: string;
  publicKey?: string;
}): SshHostKeyRecord => {
  const record: SshHostKeyRecord = {
    host: params.host,
    port: params.port,
    fingerprint: params.fingerprint,
    ...(params.keyType && params.publicKey
      ? { keyType: params.keyType, publicKey: params.publicKey }
      : {}),
    trustedAt: new Date().toISOString(),
  };
  const id = getHostKeyId(params.host, params.port);
  const records = readAllHostKeys().filter(
    (existing) => getHostKeyId(existing.host, existing.port) !== id
  );
  records.push(record);
  writeAllHostKeys(records);
  return record;
};

/**
 * Produces one exact OpenSSH known_hosts entry from an application-verified
 * host key. Legacy fingerprint-only records deliberately cannot be used here.
 */
export const formatSshKnownHost = (record: SshHostKeyRecord): string | null => {
  if (!record.keyType || !record.publicKey) {
    return null;
  }
  if (!/^[A-Za-z0-9@._+-]+$/.test(record.keyType)) {
    return null;
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(record.publicKey)) {
    return null;
  }
  const decoded = Buffer.from(record.publicKey, "base64");
  if (
    decoded.length === 0 ||
    decoded.toString("base64") !== record.publicKey
  ) {
    return null;
  }
  const host = record.port === 22 ? record.host : `[${record.host}]:${record.port}`;
  return `${host} ${record.keyType} ${record.publicKey}\n`;
};
