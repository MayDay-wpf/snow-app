import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

type ScanOperation = "hash" | "walk" | "directories" | "clear";

type WorkerRequest = {
  id: number;
  operation: ScanOperation;
  path?: string;
  maxDepth?: number;
};

type WorkerResponse = {
  id: number;
  value?: string | string[];
  error?: string;
};

export const IMPORT_SCAN_LIMITS = {
  maxFiles: 5_000,
  maxBytes: 64 * 1024 * 1024,
  maxDepth: 20,
  timeoutMs: 10_000,
} as const;

let nextRequestId = 1;
let worker: Worker | undefined;
const pending = new Map<
  number,
  {
    resolve: (value: string | string[]) => void;
    reject: (error: Error) => void;
    timeout: NodeJS.Timeout;
  }
>();

const workerPath = (): string => {
  if (process.env.VITEST) {
    return fileURLToPath(
      new URL("./import-discovery-worker.mjs", import.meta.url)
    );
  }
  return join(import.meta.dirname, "import-discovery-worker.js");
};

const failPending = (error: Error): void => {
  for (const { reject, timeout } of pending.values()) {
    clearTimeout(timeout);
    reject(error);
  }
  pending.clear();
};

const activeWorker = (): Worker => {
  if (worker) return worker;
  const path = workerPath();
  if (!existsSync(path)) {
    throw new Error(`Import discovery worker is unavailable: ${path}`);
  }
  worker = new Worker(path);
  worker.unref();
  worker.on("message", (message: WorkerResponse) => {
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    clearTimeout(request.timeout);
    if (message.error) request.reject(new Error(message.error));
    else if (message.value === undefined)
      request.reject(new Error("Import discovery worker returned no result"));
    else request.resolve(message.value);
  });
  worker.on("error", (error) => {
    worker = undefined;
    failPending(error);
  });
  worker.on("exit", (code) => {
    worker = undefined;
    if (code !== 0)
      failPending(
        new Error(`Import discovery worker exited with code ${code}`)
      );
  });
  return worker;
};

const execute = <T extends string | string[]>(
  operation: ScanOperation,
  path?: string,
  maxDepth?: number
): Promise<T> => {
  const id = nextRequestId++;
  const request: WorkerRequest = {
    id,
    operation,
    ...(path ? { path } : {}),
    ...(maxDepth ? { maxDepth } : {}),
  };
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => {
      if (!pending.delete(id)) return;
      reject(
        new Error(
          `Import discovery exceeded the ${IMPORT_SCAN_LIMITS.timeoutMs} ms limit`
        )
      );
    }, IMPORT_SCAN_LIMITS.timeoutMs + 1_000);
    pending.set(id, {
      resolve: resolve as (value: string | string[]) => void,
      reject,
      timeout,
    });
    try {
      activeWorker().postMessage(request);
    } catch (error) {
      pending.delete(id);
      clearTimeout(timeout);
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
};

export const hashImportPathInWorker = (path: string): Promise<string> =>
  execute<string>("hash", path);

export const walkImportFilesInWorker = (
  path: string,
  maxDepth: number = IMPORT_SCAN_LIMITS.maxDepth
): Promise<string[]> => execute<string[]>("walk", path, maxDepth);

export const listImportDirectoriesInWorker = (
  path: string
): Promise<string[]> => execute<string[]>("directories", path, 1);

export const clearImportDiscoveryCache = (): Promise<void> =>
  execute<string>("clear").then(() => undefined);
