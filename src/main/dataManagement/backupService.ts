import { app } from "electron";
import { createHash, randomUUID } from "node:crypto";
import {
  copyFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type {
  DataManagementBackupRecord,
  DataManagementBackupSettings,
} from "../../preload/types/dataManagement";
import type { NativeBridge } from "../native/types";
import {
  getBackupDirectory,
  getDataManagementDirectory,
  getPendingRestorePath,
} from "./paths";
import { getDataManagementSettings } from "./settingsStore";
import { createZipArchive, readZipArchive } from "./zipArchive";

const BACKUP_EXTENSION = ".snowbackup";
const BACKUP_MANIFEST = "manifest.json";
const MAIN_ENTRY = "database/snowapp.db";
const ARCHIVE_ENTRY = "database/archive.db";
const CURRENT_BACKUP_FORMAT = 1;
const STAGING_PREFIX = ".staging-";
const REDACTED_FILE_NAME = /[\\/]/;

type BackupManifestFile = {
  path: string;
  sha256: string;
  sizeBytes: number;
};

type BackupManifest = {
  formatVersion: number;
  id: string;
  appVersion: string;
  schemaVersion: number;
  createdAt: string;
  reason: string;
  deviceId: string;
  encrypted: boolean;
  includesArchive: boolean;
  includesAttachments: boolean;
  files: BackupManifestFile[];
};

type PendingRestore = {
  version: 1;
  backupPath: string;
  stageDirectory: string;
  mainPath: string;
  archivePath: string | null;
  mainSha256: string;
  archiveSha256: string | null;
  backupDirectory: string;
  createdAt: string;
  applied?: boolean;
  rollbackDirectory?: string;
};

export type AppliedRestore = PendingRestore & { rollbackDirectory: string };

const sha256 = (value: Buffer): string =>
  createHash("sha256").update(value).digest("hex");

const ensureDirectory = (directory: string): void => {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
};

const atomicWrite = (path: string, value: string): void => {
  ensureDirectory(dirname(path));
  const stagingPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(stagingPath, value, { encoding: "utf8", mode: 0o600 });
  const fd = openSync(stagingPath, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(stagingPath, path);
};

const backupSettings = (): DataManagementBackupSettings =>
  getDataManagementSettings().backup;

export const effectiveBackupDirectory = (): string => {
  const configured = backupSettings().directory.trim();
  return resolve(configured || getBackupDirectory());
};

const parseManifest = (entries: Map<string, Buffer>): BackupManifest => {
  const raw = entries.get(BACKUP_MANIFEST);
  if (!raw) {
    throw new Error("Backup manifest is missing");
  }
  let manifest: unknown;
  try {
    manifest = JSON.parse(raw.toString("utf8"));
  } catch {
    throw new Error("Backup manifest is not valid JSON");
  }
  if (!manifest || typeof manifest !== "object") {
    throw new Error("Backup manifest is invalid");
  }
  const value = manifest as Partial<BackupManifest>;
  if (
    value.formatVersion !== CURRENT_BACKUP_FORMAT ||
    typeof value.id !== "string" ||
    typeof value.createdAt !== "string" ||
    !Array.isArray(value.files) ||
    value.files.length < 1 ||
    typeof value.includesArchive !== "boolean"
  ) {
    throw new Error("Unsupported or incomplete backup manifest");
  }
  for (const file of value.files) {
    if (
      !file ||
      typeof file.path !== "string" ||
      !file.path ||
      REDACTED_FILE_NAME.test(file.path) ||
      !/^[a-f0-9]{64}$/.test(file.sha256) ||
      !Number.isSafeInteger(file.sizeBytes) ||
      file.sizeBytes < 0
    ) {
      throw new Error("Backup manifest file metadata is invalid");
    }
  }
  return value as BackupManifest;
};

const readAndValidateBackup = (
  path: string
): { manifest: BackupManifest; entries: Map<string, Buffer> } => {
  if (!isAbsolute(path) || !path.endsWith(BACKUP_EXTENSION)) {
    throw new Error("A .snowbackup file is required");
  }
  const archive = readFileSync(path);
  const entries = readZipArchive(archive, {
    maxEntries: 64,
    maxEntryBytes: 1024 * 1024 * 1024,
    maxTotalBytes: 2 * 1024 * 1024 * 1024,
  });
  const manifest = parseManifest(entries);
  for (const file of manifest.files) {
    if (!file.path || REDACTED_FILE_NAME.test(file.path) || !entries.has(file.path)) {
      throw new Error(`Backup entry is missing or unsafe: ${file.path}`);
    }
    const data = entries.get(file.path) as Buffer;
    if (data.length !== file.sizeBytes || sha256(data) !== file.sha256) {
      throw new Error(`Backup checksum mismatch: ${file.path}`);
    }
  }
  if (!entries.has(MAIN_ENTRY)) {
    throw new Error("Backup does not contain the main database");
  }
  const manifestPaths = new Set(manifest.files.map((file) => file.path));
  if (!manifestPaths.has(MAIN_ENTRY)) {
    throw new Error("Backup manifest does not declare the main database");
  }
  if (
    manifest.includesArchive !== manifestPaths.has(ARCHIVE_ENTRY) ||
    manifest.includesArchive !== entries.has(ARCHIVE_ENTRY)
  ) {
    throw new Error("Backup archive scope does not match its entries");
  }
  return { manifest, entries };
};

const recordFromManifest = (
  path: string,
  manifest: BackupManifest,
  integrity: DataManagementBackupRecord["integrity"] = "valid"
): DataManagementBackupRecord => ({
  id: manifest.id,
  path,
  createdAt: manifest.createdAt,
  reason: manifest.reason,
  appVersion: manifest.appVersion,
  schemaVersion: manifest.schemaVersion,
  sizeBytes: existsSync(path) ? statSync(path).size : 0,
  includesArchive: manifest.includesArchive,
  includesAttachments: manifest.includesAttachments,
  encrypted: manifest.encrypted,
  integrity,
});

const getDeviceId = (): string => {
  try {
    const raw = JSON.parse(
      readFileSync(join(getDataManagementDirectory(), "device.json"), "utf8")
    ) as { deviceId?: unknown };
    return typeof raw.deviceId === "string" ? raw.deviceId : "unknown";
  } catch {
    return "unknown";
  }
};

const pruneBackups = (directory: string, retentionCount: number): void => {
  const records = listBackupRecords(directory)
    .filter((record) => record.integrity === "valid")
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  for (const record of records.slice(Math.max(1, retentionCount))) {
    try {
      rmSync(record.path, { force: true });
    } catch {
      // A failed cleanup must never remove the newer safety snapshots.
    }
  }
};

export const createDatabaseBackup = async (
  native: NativeBridge,
  reason: string,
  includeArchive = backupSettings().includeArchive
): Promise<DataManagementBackupRecord> => {
  const directory = effectiveBackupDirectory();
  ensureDirectory(directory);
  const stagingDirectory = join(directory, `${STAGING_PREFIX}${randomUUID()}`);
  ensureDirectory(stagingDirectory);
  const mainPath = join(stagingDirectory, "snowapp.db");
  const archivePath = join(stagingDirectory, "archive.db");
  const id = randomUUID();
  const createdAt = new Date().toISOString();
  let temporaryPath: string | null = null;
  try {
    const info = await native.createDatabaseOnlineBackup(
      mainPath,
      includeArchive ? archivePath : undefined,
      includeArchive
    );
    const files: BackupManifestFile[] = [];
    const entries: Array<{ name: string; data: Buffer }> = [];
    const main = readFileSync(mainPath);
    files.push({ path: MAIN_ENTRY, sha256: sha256(main), sizeBytes: main.length });
    entries.push({ name: MAIN_ENTRY, data: main });
    if (includeArchive && existsSync(archivePath)) {
      const archive = readFileSync(archivePath);
      files.push({ path: ARCHIVE_ENTRY, sha256: sha256(archive), sizeBytes: archive.length });
      entries.push({ name: ARCHIVE_ENTRY, data: archive });
    }
    const manifest: BackupManifest = {
      formatVersion: CURRENT_BACKUP_FORMAT,
      id,
      appVersion: app.getVersion(),
      schemaVersion: info.schemaVersion,
      createdAt,
      reason: reason.trim() || "manual",
      deviceId: getDeviceId(),
      encrypted: false,
      includesArchive: includeArchive && entries.some((entry) => entry.name === ARCHIVE_ENTRY),
      includesAttachments: false,
      files,
    };
    entries.unshift({
      name: BACKUP_MANIFEST,
      data: Buffer.from(JSON.stringify(manifest, null, 2), "utf8"),
    });
    const targetPath = join(directory, `${createdAt.replace(/[:.]/g, "-")}-${id}${BACKUP_EXTENSION}`);
    temporaryPath = `${targetPath}.${process.pid}.tmp`;
    writeFileSync(temporaryPath, createZipArchive(entries), { mode: 0o600 });
    renameSync(temporaryPath, targetPath);
    temporaryPath = null;
    let validatedManifest: BackupManifest;
    try {
      ({ manifest: validatedManifest } = readAndValidateBackup(targetPath));
    } catch (error) {
      rmSync(targetPath, { force: true });
      throw new Error(
        `Created backup package failed validation: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    pruneBackups(directory, backupSettings().retentionCount);
    return recordFromManifest(targetPath, validatedManifest, "valid");
  } finally {
    if (temporaryPath) rmSync(temporaryPath, { force: true });
    rmSync(stagingDirectory, { recursive: true, force: true });
  }
};

export const listBackupRecords = (
  directory = effectiveBackupDirectory()
): DataManagementBackupRecord[] => {
  if (!existsSync(directory)) {
    return [];
  }
  const records: DataManagementBackupRecord[] = [];
  for (const name of readdirSync(directory)) {
    if (!name.endsWith(BACKUP_EXTENSION) || name.startsWith(".")) {
      continue;
    }
    const path = join(directory, name);
    try {
      const { manifest } = readAndValidateBackup(path);
      records.push(recordFromManifest(path, manifest, "valid"));
    } catch {
      records.push({
        id: name,
        path,
        createdAt: new Date(statSync(path).mtimeMs).toISOString(),
        reason: "unknown",
        appVersion: "unknown",
        schemaVersion: 0,
        sizeBytes: statSync(path).size,
        includesArchive: false,
        includesAttachments: false,
        encrypted: false,
        integrity: "invalid",
      });
    }
  }
  return records.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
};

const assertInsideDirectory = (path: string, directory: string): void => {
  const relativePath = relative(resolve(directory), resolve(path));
  if (!relativePath || relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw new Error("Backup path must stay inside the configured backup directory");
  }
};

export const deleteDatabaseBackup = (path: string): void => {
  assertInsideDirectory(path, effectiveBackupDirectory());
  if (!path.endsWith(BACKUP_EXTENSION)) {
    throw new Error("Only .snowbackup files can be deleted");
  }
  const pending = readPendingRestore();
  if (pending?.backupPath === resolve(path)) {
    throw new Error("The backup selected for restore cannot be deleted");
  }
  rmSync(path, { force: true });
};

export const stageDatabaseRestore = (path: string): DataManagementBackupRecord => {
  const { manifest, entries } = readAndValidateBackup(path);
  const directory = effectiveBackupDirectory();
  const stageDirectory = join(directory, `${STAGING_PREFIX}restore-${randomUUID()}`);
  ensureDirectory(stageDirectory);
  const mainPath = join(stageDirectory, "snowapp.db");
  const archivePath = manifest.includesArchive && entries.has(ARCHIVE_ENTRY)
    ? join(stageDirectory, "archive.db")
    : null;
  writeFileSync(mainPath, entries.get(MAIN_ENTRY) as Buffer, { mode: 0o600 });
  if (archivePath) {
    writeFileSync(archivePath, entries.get(ARCHIVE_ENTRY) as Buffer, { mode: 0o600 });
  }
  const pending: PendingRestore = {
    version: 1,
    backupPath: resolve(path),
    stageDirectory,
    mainPath,
    archivePath,
    mainSha256: sha256(entries.get(MAIN_ENTRY) as Buffer),
    archiveSha256: archivePath ? sha256(entries.get(ARCHIVE_ENTRY) as Buffer) : null,
    backupDirectory: directory,
    createdAt: new Date().toISOString(),
  };
  atomicWrite(getPendingRestorePath(), JSON.stringify(pending, null, 2));
  return recordFromManifest(path, manifest, "valid");
};

export const readPendingRestore = (): PendingRestore | null => {
  if (!existsSync(getPendingRestorePath())) {
    return null;
  }
  try {
    const value = JSON.parse(readFileSync(getPendingRestorePath(), "utf8")) as PendingRestore;
    if (value?.version !== 1 || typeof value.stageDirectory !== "string") {
      return null;
    }
    return {
      ...value,
      backupDirectory:
        typeof value.backupDirectory === "string"
          ? value.backupDirectory
          : dirname(value.stageDirectory),
    };
  } catch {
    return null;
  }
};

const copyIntoPlace = (source: string, target: string): void => {
  ensureDirectory(dirname(target));
  const temporaryPath = `${target}.${process.pid}.${randomUUID()}.restore`;
  copyFileSync(source, temporaryPath);
  renameSync(temporaryPath, target);
};

const removeSidecars = (path: string): void => {
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    rmSync(`${path}${suffix}`, { force: true });
  }
};

export const applyPendingRestore = async (
  native: NativeBridge
): Promise<AppliedRestore | null> => {
  const pending = readPendingRestore();
  if (!pending) {
    return null;
  }
  assertInsideDirectory(pending.stageDirectory, pending.backupDirectory);
  assertInsideDirectory(pending.mainPath, pending.stageDirectory);
  if (pending.archivePath) {
    assertInsideDirectory(pending.archivePath, pending.stageDirectory);
  }
  if (pending.rollbackDirectory) {
    assertInsideDirectory(pending.rollbackDirectory, pending.stageDirectory);
  }
  if (pending.applied && pending.rollbackDirectory) {
    // The previous process completed the file swap but exited before it could
    // finish application initialization. Keep the rollback copy alive until
    // this startup has initialized successfully.
    try {
      await native.quickCheckDatabase(join(homedir(), ".snowapp", "snowapp.db"));
      if (pending.archivePath) {
        await native.quickCheckDatabase(join(homedir(), ".snowapp", "archive.db"));
      }
    } catch (error) {
      rollbackPendingRestore(pending as AppliedRestore);
      throw error;
    }
    return pending as AppliedRestore;
  }
  const main = readFileSync(pending.mainPath);
  if (sha256(main) !== pending.mainSha256) {
    throw new Error("Pending restore main database checksum mismatch");
  }
  await native.quickCheckDatabase(pending.mainPath);
  if (pending.archivePath) {
    const archive = readFileSync(pending.archivePath);
    if (pending.archiveSha256 !== sha256(archive)) {
      throw new Error("Pending restore archive database checksum mismatch");
    }
    await native.quickCheckDatabase(pending.archivePath);
  }

  const storageDirectory = join(homedir(), ".snowapp");
  ensureDirectory(storageDirectory);
  const mainPath = join(storageDirectory, "snowapp.db");
  const archivePath = join(storageDirectory, "archive.db");
  const rollbackDirectory = join(pending.stageDirectory, "rollback");
  ensureDirectory(rollbackDirectory);
  if (existsSync(mainPath)) copyFileSync(mainPath, join(rollbackDirectory, "snowapp.db"));
  if (existsSync(archivePath)) copyFileSync(archivePath, join(rollbackDirectory, "archive.db"));
  try {
    copyIntoPlace(pending.mainPath, mainPath);
    removeSidecars(mainPath);
    if (pending.archivePath) {
      copyIntoPlace(pending.archivePath, archivePath);
      removeSidecars(archivePath);
    }
  } catch (error) {
    rollbackPendingRestore({ ...pending, applied: true, rollbackDirectory });
    throw error;
  }
  const applied: AppliedRestore = {
    ...pending,
    applied: true,
    rollbackDirectory,
  };
  atomicWrite(getPendingRestorePath(), JSON.stringify(applied, null, 2));
  return applied;
};

export const finalizePendingRestore = (restore: AppliedRestore): void => {
  rmSync(restore.rollbackDirectory, { recursive: true, force: true });
  rmSync(restore.stageDirectory, { recursive: true, force: true });
  rmSync(getPendingRestorePath(), { force: true });
};

export const rollbackPendingRestore = (restore: AppliedRestore): void => {
  const storageDirectory = join(homedir(), ".snowapp");
  const mainPath = join(storageDirectory, "snowapp.db");
  const archivePath = join(storageDirectory, "archive.db");
  const rollbackMain = join(restore.rollbackDirectory, "snowapp.db");
  const rollbackArchive = join(restore.rollbackDirectory, "archive.db");
  if (existsSync(rollbackMain)) copyIntoPlace(rollbackMain, mainPath);
  else rmSync(mainPath, { force: true });
  if (existsSync(rollbackArchive)) copyIntoPlace(rollbackArchive, archivePath);
  else rmSync(archivePath, { force: true });
  removeSidecars(mainPath);
  removeSidecars(archivePath);
  rmSync(restore.rollbackDirectory, { recursive: true, force: true });
  rmSync(restore.stageDirectory, { recursive: true, force: true });
  rmSync(getPendingRestorePath(), { force: true });
};

export const cleanupStaleBackupStaging = (): void => {
  const directory = effectiveBackupDirectory();
  if (!existsSync(directory)) return;
  const pending = readPendingRestore();
  const now = Date.now();
  for (const name of readdirSync(directory)) {
    if (!name.startsWith(STAGING_PREFIX)) continue;
    const path = join(directory, name);
    if (pending && resolve(pending.stageDirectory) === resolve(path)) continue;
    try {
      if (now - statSync(path).mtimeMs > 24 * 60 * 60 * 1000) {
        rmSync(path, { recursive: true, force: true });
      }
    } catch {
      // Best effort cleanup only.
    }
  }
};
